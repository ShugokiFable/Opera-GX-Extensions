#!/usr/bin/env python3
"""NebulaGrab Companion: resilient local downloader for authorized, non-DRM media."""

from __future__ import annotations

import argparse
import concurrent.futures
import email.message
import hmac
import hashlib
import importlib.util
import ipaddress
import json
import math
import os
import random
import re
import secrets
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import asdict, dataclass, field
from http.client import IncompleteRead
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, BinaryIO

VERSION = "1.3.0"
HOST = "127.0.0.1"
PORT = 17891
ROOT = Path(__file__).resolve().parent
CONFIG_PATH = ROOT / "config.json"
MAX_BODY = 32 * 1024 * 1024
MAX_MANIFEST_BYTES = 4 * 1024 * 1024
ALLOWED_ORIGIN_PREFIXES = ("chrome-extension://", "opera-extension://")
ALLOW_PRIVATE = os.environ.get("NEBULAGRAB_ALLOW_PRIVATE") == "1"
USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/149 Safari/537.36 NebulaGrab/1.3"
HEADER_ALLOWLIST = {
    "accept", "accept-language", "authorization", "cookie", "origin", "range", "referer", "user-agent",
    "x-requested-with", "sec-fetch-dest", "sec-fetch-mode", "sec-fetch-site",
}
SENSITIVE_HEADERS = {"authorization", "cookie"}
BROWSER_NAMES = {"brave", "chrome", "chromium", "edge", "firefox", "opera", "vivaldi", "whale"}
# Filename sanitizer: disjoint unsafe-char class, then rstrip (not `[. ]+$`, which is quadratic).
_UNSAFE_FILENAME_CHARS = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
_KNOWN_MEDIA_EXT = re.compile(
    r"\.(?:mp4|mkv|webm|mov|m4v|avi|flv|ts|m2ts|mp3|m4a|aac|flac|wav|ogg|opus|jpg|jpeg|png|gif|webp|avif)$",
    re.IGNORECASE,
)

JOBS: dict[str, "Job"] = {}
JOBS_LOCK = threading.Lock()
_TOOL_CAPABILITIES: dict[str, Any] = {}


@dataclass
class Job:
    id: str
    url: str
    output: str
    mode: str = "auto"
    status: str = "queued"
    progress: float | None = None
    duration: float | None = None
    position: float | None = None
    bytes_downloaded: int = 0
    bytes_total: int | None = None
    speed: float | None = None
    eta: float | None = None
    attempt: int = 0
    cache_path: str = ""
    cache_key: str = ""
    backend: str = ""
    error: str = ""
    log_tail: list[str] = field(default_factory=list)
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)

    def public(self) -> dict[str, Any]:
        data = asdict(self)
        data["createdAt"] = data.pop("created_at")
        data["updatedAt"] = data.pop("updated_at")
        data["bytesDownloaded"] = data.pop("bytes_downloaded")
        data["bytesTotal"] = data.pop("bytes_total")
        data["cachePath"] = data.pop("cache_path")
        data["cacheKey"] = data.pop("cache_key")
        data["logTail"] = data.pop("log_tail")
        return data


def load_config() -> dict[str, Any]:
    default_output = Path.home() / "Downloads" / "NebulaGrab"
    default_cache = Path.home() / ".nebulagrab-cache"
    config: dict[str, Any] = {
        "token": secrets.token_urlsafe(32),
        "output_dir": str(default_output),
        "cache_dir": str(default_cache),
        "direct_workers": 6,
        "chunk_size_mb": 16,
        "direct_retries": 12,
        "stream_retries": 30,
        "concurrent_fragments": 8,
        "job_restarts": 3,
        "fsync_interval_mb": 64,
        "impersonate_generic": True,
        "keep_failed_cache": True,
        "captured_fragment_limit": 12000,
    }
    if CONFIG_PATH.exists():
        try:
            loaded = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                for key in config:
                    if key in loaded and loaded[key] not in (None, ""):
                        config[key] = loaded[key]
        except (OSError, json.JSONDecodeError):
            pass
    CONFIG_PATH.write_text(json.dumps(config, indent=2), encoding="utf-8")
    return config


CONFIG = load_config()
OUTPUT_DIR = Path(str(CONFIG["output_dir"])).expanduser().resolve()
CACHE_DIR = Path(str(CONFIG["cache_dir"])).expanduser().resolve()
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
CACHE_DIR.mkdir(parents=True, exist_ok=True)
(CACHE_DIR / "jobs").mkdir(parents=True, exist_ok=True)
(CACHE_DIR / "yt-dlp").mkdir(parents=True, exist_ok=True)


def ffmpeg_executable() -> str | None:
    local = ROOT / "bin" / ("ffmpeg.exe" if os.name == "nt" else "ffmpeg")
    if local.exists():
        return str(local)
    return shutil.which("ffmpeg")


def ffprobe_executable() -> str | None:
    local = ROOT / "bin" / ("ffprobe.exe" if os.name == "nt" else "ffprobe")
    if local.exists():
        return str(local)
    return shutil.which("ffprobe")


def ytdlp_command() -> list[str] | None:
    local = ROOT / "bin" / ("yt-dlp.exe" if os.name == "nt" else "yt-dlp")
    if local.exists():
        return [str(local)]
    found = shutil.which("yt-dlp")
    if found:
        return [found]
    if importlib.util.find_spec("yt_dlp") is not None:
        return [sys.executable, "-m", "yt_dlp"]
    return None


def tool_version(command: list[str] | None) -> str:
    if not command or not command[0]:
        return ""
    try:
        args = list(command)
        if len(args) == 1 or args[-1] not in {"--version", "-version"}:
            args.append("--version")
        result = subprocess.run(args, capture_output=True, text=True, timeout=8, check=False)
        text = (result.stdout or result.stderr or "").strip().splitlines()
        return text[0][:120] if text else ""
    except Exception:  # noqa: BLE001
        return ""


def ytdlp_impersonation_available() -> bool:
    cached = _TOOL_CAPABILITIES.get("yt_dlp_impersonation")
    if isinstance(cached, bool):
        return cached
    command = ytdlp_command()
    if not command:
        _TOOL_CAPABILITIES["yt_dlp_impersonation"] = False
        return False
    try:
        result = subprocess.run([*command, "--list-impersonate-targets"], capture_output=True, text=True, timeout=12, check=False)
        text = f"{result.stdout}\n{result.stderr}"
        available = any(
            re.search(r"(?i)\bchrome\b", line) and "unavailable" not in line.lower()
            for line in text.splitlines()
        )
    except Exception:  # noqa: BLE001
        available = False
    _TOOL_CAPABILITIES["yt_dlp_impersonation"] = available
    return available


def sanitize_filename(value: str) -> str:
    value = _UNSAFE_FILENAME_CHARS.sub("_", value or "media")
    value = value.rstrip(". ").strip()
    return value[:180] or "media"


def strip_known_extension(value: str) -> str:
    return _KNOWN_MEDIA_EXT.sub("", value)


def extension_from_url(url: str) -> str:
    try:
        suffix = Path(urllib.parse.urlparse(url).path).suffix
        if re.fullmatch(r"\.[A-Za-z0-9]{1,8}", suffix or ""):
            return suffix.lower()
    except Exception:  # noqa: BLE001
        pass
    return ""


def extension_from_mime(mime: str) -> str:
    return {
        "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/avif": ".avif",
        "image/gif": ".gif", "video/mp4": ".mp4", "video/webm": ".webm", "video/quicktime": ".mov",
        "audio/mpeg": ".mp3", "audio/mp4": ".m4a", "audio/ogg": ".ogg", "audio/flac": ".flac",
    }.get((mime or "").split(";", 1)[0].lower(), "")


def unique_output(filename: str) -> Path:
    clean = sanitize_filename(filename)
    path = OUTPUT_DIR / clean
    stem, suffix = path.stem, path.suffix
    index = 2
    while path.exists():
        path = OUTPUT_DIR / f"{stem} ({index}){suffix}"
        index += 1
    return path


def stable_url_identity(value: str) -> str:
    try:
        parsed = urllib.parse.urlsplit(value)
        if parsed.scheme not in {"http", "https"}:
            return value
        return urllib.parse.urlunsplit((parsed.scheme.lower(), parsed.netloc.lower(), parsed.path, "", ""))
    except Exception:  # noqa: BLE001
        return value


def stable_cache_key(payload: dict[str, Any]) -> str:
    supplied = str(payload.get("cacheKey") or "").strip()
    if re.fullmatch(r"[A-Za-z0-9_.-]{8,128}", supplied):
        material = supplied
    else:
        material = json.dumps({
            "url": stable_url_identity(str(payload.get("url") or "")),
            "page": stable_url_identity(str(payload.get("referrer") or payload.get("pageUrl") or "")),
            "kind": str(payload.get("kind") or ""),
            "title": strip_known_extension(str(payload.get("title") or payload.get("filename") or "media")),
            "size": payload.get("size") or payload.get("bytesTotal") or None,
        }, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(material.encode("utf-8", errors="replace")).hexdigest()[:32]


def cache_root_for(payload: dict[str, Any]) -> Path:
    return CACHE_DIR / "jobs" / stable_cache_key(payload)


def atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
    temp.replace(path)


def read_json_file(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def cache_metadata_compatible(root: Path, probe: dict[str, Any]) -> bool:
    meta = read_json_file(root / "job.json")
    if not meta:
        return True
    old_total = meta.get("total")
    new_total = probe.get("total")
    if old_total is not None and new_total is not None:
        try:
            if int(old_total) != int(new_total):
                return False
        except (TypeError, ValueError):
            return False
    for old_key, new_key in (("etag", "etag"), ("lastModified", "last_modified")):
        old_value = str(meta.get(old_key) or "")
        new_value = str(probe.get(new_key) or "")
        if old_value and new_value and old_value != new_value:
            return False
    return True


def prepare_cache_root(root: Path, probe: dict[str, Any], payload: dict[str, Any]) -> None:
    if root.exists() and not cache_metadata_compatible(root, probe):
        shutil.rmtree(root, ignore_errors=True)
    root.mkdir(parents=True, exist_ok=True)
    atomic_write_json(root / "job.json", {
        "version": VERSION,
        "cacheKey": root.name,
        "urlHash": hashlib.sha256(str(payload.get("url") or "").encode("utf-8", errors="replace")).hexdigest(),
        "stableUrl": stable_url_identity(str(payload.get("url") or "")),
        "total": probe.get("total"),
        "etag": probe.get("etag", ""),
        "lastModified": probe.get("last_modified", ""),
        "mime": probe.get("mime", ""),
        "updatedAt": time.time(),
        "headers": redacted_headers(safe_request_headers(payload.get("headers"), str(payload.get("referrer") or ""))),
    })


def durable_flush(handle: BinaryIO, pending: int, threshold: int) -> int:
    if pending >= threshold:
        handle.flush()
        os.fsync(handle.fileno())
        return 0
    return pending


def sanitize_header_value(value: str) -> str:
    return str(value).replace("\r", "").replace("\n", "")


def is_extension_origin(origin: str) -> bool:
    cleaned = sanitize_header_value(origin)
    if cleaned != str(origin):
        return False
    return not cleaned or cleaned.startswith(ALLOWED_ORIGIN_PREFIXES)


def _ascii_hostname(hostname: str) -> str:
    try:
        ipaddress.ip_address(hostname)
        return hostname
    except ValueError:
        try:
            return hostname.encode("idna").decode("ascii").lower()
        except UnicodeError as exc:
            raise ValueError("Invalid remote URL hostname.") from exc


def reconstruct_remote_url(url: str) -> str:
    parsed = urllib.parse.urlsplit(url)
    scheme = (parsed.scheme or "").lower()
    if scheme not in {"http", "https"}:
        raise ValueError("Only HTTP and HTTPS media URLs are allowed.")
    hostname = parsed.hostname
    if not hostname or parsed.username or parsed.password:
        raise ValueError("Invalid remote URL.")
    try:
        port = parsed.port
    except ValueError as exc:
        raise ValueError("Invalid remote URL.") from exc
    host = _ascii_hostname(hostname)
    try:
        ipaddress.ip_address(host)
        netloc_host = f"[{host}]" if ":" in host else host
    except ValueError:
        netloc_host = host
    netloc = f"{netloc_host}:{port}" if port is not None else netloc_host
    return urllib.parse.urlunsplit((scheme, netloc, parsed.path, parsed.query, ""))


def validate_remote_url(url: str) -> str:
    safe_url = reconstruct_remote_url(url)
    parsed = urllib.parse.urlsplit(safe_url)
    hostname = parsed.hostname
    if not hostname:
        raise ValueError("Invalid remote URL.")

    if ALLOW_PRIVATE:
        return safe_url

    try:
        infos = socket.getaddrinfo(
            hostname,
            parsed.port or (443 if parsed.scheme == "https" else 80),
            type=socket.SOCK_STREAM,
        )
    except socket.gaierror as exc:
        raise ValueError(f"Could not resolve media host: {exc}") from exc
    if not infos:
        raise ValueError("Could not resolve media host.")
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        # Require a globally routable unicast address. `is_global` is stricter
        # than the private/loopback set (CGNAT, documentation, benchmark), but
        # some Python versions still report multicast as global.
        if (
            not ip.is_global
            or ip.is_private
            or ip.is_loopback
            or ip.is_link_local
            or ip.is_reserved
            or ip.is_multicast
            or ip.is_unspecified
        ):
            raise ValueError("Private-network and localhost media URLs are blocked by default.")
    return safe_url


class SafeRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req: urllib.request.Request, fp: BinaryIO, code: int, msg: str, headers: email.message.Message, newurl: str) -> urllib.request.Request | None:
        safe = validate_remote_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, safe)


OPENER = urllib.request.build_opener(SafeRedirectHandler())


def safe_request_headers(raw: Any, referrer: str = "") -> dict[str, str]:
    result: dict[str, str] = {"User-Agent": USER_AGENT, "Accept-Encoding": "identity"}
    if isinstance(raw, dict):
        for key, value in raw.items():
            name = str(key).strip().lower()
            text = str(value).replace("\r", "").replace("\n", "").strip()
            if name in HEADER_ALLOWLIST and text and len(text) <= 16_384:
                result["-".join(part.capitalize() for part in name.split("-"))] = text
    if referrer.startswith(("http://", "https://")) and "Referer" not in result:
        result["Referer"] = sanitize_header_value(referrer)
    return result


def redacted_headers(headers: dict[str, str]) -> dict[str, str]:
    return {key: ("<redacted>" if key.lower() in SENSITIVE_HEADERS else value) for key, value in headers.items()}


def open_remote(url: str, headers: dict[str, str], method: str = "GET", timeout: int = 35) -> Any:
    safe_url = validate_remote_url(url)
    request = urllib.request.Request(safe_url, headers=headers, method=method)
    response = OPENER.open(request, timeout=timeout)
    validate_remote_url(response.geturl())
    return response


def fetch_text(url: str, referrer: str = "", headers: dict[str, str] | None = None) -> tuple[str, str]:
    merged = safe_request_headers(headers or {}, referrer)
    merged["Accept"] = "*/*"
    try:
        with open_remote(url, merged, timeout=25) as response:
            final_url = response.geturl()
            raw = response.read(MAX_MANIFEST_BYTES + 1)
            if len(raw) > MAX_MANIFEST_BYTES:
                raise ValueError("Manifest is larger than the safety limit.")
            charset = response.headers.get_content_charset() or "utf-8"
            return raw.decode(charset, errors="replace"), final_url
    except urllib.error.HTTPError as exc:
        raise ValueError(f"Manifest request returned HTTP {exc.code}.") from exc
    except urllib.error.URLError as exc:
        raise ValueError(f"Manifest request failed: {exc.reason}") from exc


def inspect_hls(url: str, referrer: str = "", headers: dict[str, str] | None = None, visited: set[str] | None = None, depth: int = 0) -> dict[str, Any]:
    if depth > 4:
        raise ValueError("HLS playlist nesting is too deep.")
    visited = visited or set()
    if url in visited:
        return {"encrypted": False, "drm": False, "playlists": len(visited)}
    if len(visited) >= 40:
        raise ValueError("HLS playlist fan-out exceeded the safety limit.")
    visited.add(url)

    text, final_url = fetch_text(url, referrer, headers)
    upper = text.upper()
    encrypted = bool(re.search(r"#EXT-X-KEY\s*:[^\n]*METHOD\s*=\s*(?!NONE)", upper)) or "SAMPLE-AES" in upper
    drm = bool(re.search(r"KEYFORMAT\s*=\s*\"?(COM\.APPLE\.STREAMINGKEYDELIVERY|URN:UUID:)", upper))
    if encrypted or drm:
        return {"encrypted": encrypted, "drm": drm, "playlists": len(visited)}

    nested: list[str] = []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        if line.startswith("#EXT-X-MEDIA"):
            match = re.search(r'URI="([^"]+)"', line, re.IGNORECASE)
            if match:
                nested.append(urllib.parse.urljoin(final_url, match.group(1)))
            continue
        if line.startswith("#"):
            continue
        resolved = urllib.parse.urljoin(final_url, line)
        validate_remote_url(resolved)
        if ".m3u8" in urllib.parse.urlparse(resolved).path.lower():
            nested.append(resolved)

    for child in nested:
        result = inspect_hls(child, referrer or final_url, headers, visited, depth + 1)
        if result["encrypted"] or result["drm"]:
            return result

    return {"encrypted": False, "drm": False, "playlists": len(visited)}


def inspect_dash(url: str, referrer: str = "", headers: dict[str, str] | None = None) -> dict[str, Any]:
    text, final_url = fetch_text(url, referrer, headers)
    drm = bool(re.search(r"<ContentProtection\b|cenc:|urn:uuid:(edef8ba9|9a04f079|e2719d58)", text, re.IGNORECASE))
    for absolute in re.findall(r"https?://[^\s<>\"']+", text, re.IGNORECASE):
        validate_remote_url(absolute)
    for base in re.findall(r"<BaseURL[^>]*>(.*?)</BaseURL>", text, re.IGNORECASE | re.DOTALL):
        value = re.sub(r"\s+", "", base)
        if value:
            validate_remote_url(urllib.parse.urljoin(final_url, value))
    return {"encrypted": drm, "drm": drm}


def inspect_stream(url: str, kind: str, referrer: str = "", headers: dict[str, str] | None = None) -> dict[str, Any]:
    validate_remote_url(url)
    if kind == "hls" or ".m3u8" in urllib.parse.urlparse(url).path.lower():
        return inspect_hls(url, referrer, headers)
    if kind == "dash" or ".mpd" in urllib.parse.urlparse(url).path.lower():
        return inspect_dash(url, referrer, headers)
    return {"encrypted": False, "drm": False}


def parse_timestamp(value: str) -> float | None:
    match = re.match(r"(\d+):(\d+):(\d+(?:\.\d+)?)", value)
    if not match:
        return None
    hours, minutes, seconds = match.groups()
    return int(hours) * 3600 + int(minutes) * 60 + float(seconds)


def update_job(job_id: str, **changes: Any) -> None:
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        if not job:
            return
        for key, value in changes.items():
            setattr(job, key, value)
        job.updated_at = time.time()


def append_job_log(job_id: str, line: str) -> None:
    clean = re.sub(r"(?i)(cookie|authorization):\s*[^\r\n]+", r"\1: <redacted>", line.strip())[-500:]
    if not clean:
        return
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        if not job:
            return
        job.log_tail = (job.log_tail + [clean])[-12:]
        job.updated_at = time.time()


def retry_sleep(attempt: int, cap: float = 30.0) -> None:
    delay = min(cap, 0.75 * (2 ** min(attempt, 6))) + random.uniform(0.0, 0.5)
    time.sleep(delay)


def parse_content_range(value: str) -> tuple[int, int, int | None] | None:
    match = re.match(r"bytes\s+(\d+)-(\d+)/(\d+|\*)", value or "", re.I)
    if not match:
        return None
    start, end, total = match.groups()
    return int(start), int(end), None if total == "*" else int(total)


def probe_remote(url: str, headers: dict[str, str]) -> dict[str, Any]:
    result: dict[str, Any] = {"total": None, "ranges": False, "etag": "", "last_modified": "", "mime": "", "final_url": url}
    try:
        with open_remote(url, headers, method="HEAD", timeout=25) as response:
            result.update({
                "total": int(response.headers.get("Content-Length")) if str(response.headers.get("Content-Length", "")).isdigit() else None,
                "ranges": "bytes" in response.headers.get("Accept-Ranges", "").lower(),
                "etag": response.headers.get("ETag", ""),
                "last_modified": response.headers.get("Last-Modified", ""),
                "mime": response.headers.get("Content-Type", "").split(";", 1)[0],
                "final_url": response.geturl(),
            })
    except Exception:  # noqa: BLE001
        pass

    range_headers = {**headers, "Range": "bytes=0-0"}
    try:
        with open_remote(url, range_headers, timeout=25) as response:
            content_range = parse_content_range(response.headers.get("Content-Range", ""))
            if response.status == 206 and content_range:
                result["ranges"] = True
                result["total"] = content_range[2]
            elif result["total"] is None:
                length = response.headers.get("Content-Length", "")
                result["total"] = int(length) if str(length).isdigit() else None
            result["etag"] = result["etag"] or response.headers.get("ETag", "")
            result["last_modified"] = result["last_modified"] or response.headers.get("Last-Modified", "")
            result["mime"] = result["mime"] or response.headers.get("Content-Type", "").split(";", 1)[0]
            result["final_url"] = response.geturl()
    except Exception:  # noqa: BLE001
        pass
    return result


class RangeUnsupported(RuntimeError):
    pass


def download_range_chunk(job_id: str, url: str, headers: dict[str, str], chunk_path: Path, start: int, end: int, validator: str, progress_state: dict[str, Any], progress_lock: threading.Lock) -> None:
    expected = end - start + 1
    existing = chunk_path.stat().st_size if chunk_path.exists() else 0
    if existing == expected:
        return
    if existing > expected:
        chunk_path.unlink(missing_ok=True)
        existing = 0

    retries = max(1, int(CONFIG.get("direct_retries", 12)))
    fsync_threshold = max(4, int(CONFIG.get("fsync_interval_mb", 64))) * 1024 * 1024
    for attempt in range(retries):
        request_start = start + existing
        request_headers = {**headers, "Range": f"bytes={request_start}-{end}"}
        if validator:
            request_headers["If-Range"] = validator
        try:
            with open_remote(url, request_headers, timeout=40) as response:
                if response.status != 206:
                    raise RangeUnsupported(f"Server ignored byte-range request with HTTP {response.status}.")
                parsed = parse_content_range(response.headers.get("Content-Range", ""))
                if not parsed or parsed[0] != request_start:
                    raise RangeUnsupported("Server returned an invalid Content-Range.")
                chunk_path.parent.mkdir(parents=True, exist_ok=True)
                pending_sync = 0
                with chunk_path.open("ab") as output:
                    while True:
                        block = response.read(1024 * 1024)
                        if not block:
                            break
                        output.write(block)
                        pending_sync += len(block)
                        pending_sync = durable_flush(output, pending_sync, fsync_threshold)
                        existing += len(block)
                        with progress_lock:
                            progress_state["downloaded"] += len(block)
                            elapsed = max(0.001, time.monotonic() - progress_state["started"])
                            rate = progress_state["downloaded"] / elapsed
                            total = progress_state["total"]
                            current = progress_state["base"] + progress_state["downloaded"]
                            update_job(
                                job_id,
                                bytes_downloaded=current,
                                bytes_total=total,
                                progress=min(100.0, current / total * 100.0) if total else None,
                                speed=rate,
                                eta=max(0.0, (total - current) / rate) if total and rate > 0 else None,
                            )
                    output.flush()
                    os.fsync(output.fileno())
                if existing != expected:
                    raise IOError(f"Chunk ended early ({existing}/{expected} bytes).")
                return
        except RangeUnsupported:
            raise
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError, IncompleteRead) as exc:
            append_job_log(job_id, f"Chunk {start}-{end} retry {attempt + 1}/{retries}: {exc}")
            if attempt + 1 >= retries:
                raise RuntimeError(f"Chunk {start}-{end} failed after {retries} attempts: {exc}") from exc
            existing = chunk_path.stat().st_size if chunk_path.exists() else 0
            retry_sleep(attempt)


def run_chunked_direct(job_id: str, url: str, headers: dict[str, str], output: Path, probe: dict[str, Any], root: Path) -> None:
    total = int(probe["total"])
    chunk_size = max(4, min(128, int(CONFIG.get("chunk_size_mb", 16)))) * 1024 * 1024
    chunk_count = math.ceil(total / chunk_size)
    cache_path = root / "chunks"
    cache_path.mkdir(parents=True, exist_ok=True)
    validator = str(probe.get("etag") or probe.get("last_modified") or "")

    existing_total = 0
    tasks: list[tuple[Path, int, int]] = []
    for index in range(chunk_count):
        start = index * chunk_size
        end = min(total - 1, start + chunk_size - 1)
        path = cache_path / f"{index:08d}.chunk"
        expected = end - start + 1
        if path.exists() and path.stat().st_size == expected:
            existing_total += expected
        else:
            if path.exists() and path.stat().st_size > expected:
                path.unlink(missing_ok=True)
            existing_total += path.stat().st_size if path.exists() else 0
            tasks.append((path, start, end))

    update_job(job_id, backend="range-cache", cache_path=str(root), bytes_downloaded=existing_total, bytes_total=total, progress=existing_total / total * 100.0)
    progress_state = {
        "base": existing_total,
        "downloaded": 0,
        "total": total,
        "started": time.monotonic(),
    }
    lock = threading.Lock()
    workers = max(1, min(16, int(CONFIG.get("direct_workers", 6)), len(tasks) or 1))
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers, thread_name_prefix="ng-range") as executor:
        futures = [executor.submit(download_range_chunk, job_id, url, headers, path, start, end, validator, progress_state, lock) for path, start, end in tasks]
        for future in concurrent.futures.as_completed(futures):
            future.result()

    assembling = root / "payload.assembling"
    with assembling.open("wb") as merged:
        for index in range(chunk_count):
            chunk = cache_path / f"{index:08d}.chunk"
            with chunk.open("rb") as source:
                shutil.copyfileobj(source, merged, length=1024 * 1024)
        merged.flush()
        os.fsync(merged.fileno())
    if assembling.stat().st_size != total:
        raise RuntimeError(f"Assembled file size mismatch ({assembling.stat().st_size}/{total}).")
    output.parent.mkdir(parents=True, exist_ok=True)
    assembling.replace(output)
    shutil.rmtree(root, ignore_errors=True)


def run_sequential_direct(job_id: str, url: str, headers: dict[str, str], output: Path, probe: dict[str, Any], root: Path) -> None:
    partial = root / "payload.partial"
    total = probe.get("total")
    retries = max(1, int(CONFIG.get("direct_retries", 12)))
    fsync_threshold = max(4, int(CONFIG.get("fsync_interval_mb", 64))) * 1024 * 1024
    session_start = time.monotonic()
    base_at_start = partial.stat().st_size if partial.exists() else 0
    update_job(job_id, backend="sequential-cache", cache_path=str(root), bytes_downloaded=base_at_start, bytes_total=total)

    for attempt in range(retries):
        existing = partial.stat().st_size if partial.exists() else 0
        if total is not None and existing == int(total):
            output.parent.mkdir(parents=True, exist_ok=True)
            partial.replace(output)
            shutil.rmtree(root, ignore_errors=True)
            return
        if total is not None and existing > int(total):
            partial.unlink(missing_ok=True)
            existing = 0
        request_headers = dict(headers)
        if existing:
            request_headers["Range"] = f"bytes={existing}-"
            validator = str(probe.get("etag") or probe.get("last_modified") or "")
            if validator:
                request_headers["If-Range"] = validator
        try:
            with open_remote(url, request_headers, timeout=45) as response:
                append = existing > 0 and response.status == 206
                if existing > 0 and response.status == 200:
                    partial.unlink(missing_ok=True)
                    existing = 0
                    append = False
                content_range = parse_content_range(response.headers.get("Content-Range", ""))
                if content_range and content_range[2]:
                    total = content_range[2]
                elif total is None:
                    length = response.headers.get("Content-Length", "")
                    if str(length).isdigit():
                        total = existing + int(length) if append else int(length)
                mode = "ab" if append else "wb"
                pending_sync = 0
                with partial.open(mode) as target:
                    while True:
                        block = response.read(1024 * 1024)
                        if not block:
                            break
                        target.write(block)
                        pending_sync += len(block)
                        pending_sync = durable_flush(target, pending_sync, fsync_threshold)
                        existing += len(block)
                        elapsed = max(0.001, time.monotonic() - session_start)
                        rate = max(0, existing - base_at_start) / elapsed
                        update_job(
                            job_id,
                            bytes_downloaded=existing,
                            bytes_total=total,
                            progress=min(100.0, existing / total * 100.0) if total else None,
                            speed=rate,
                            eta=max(0.0, (total - existing) / rate) if total and rate > 0 else None,
                        )
                    target.flush()
                    os.fsync(target.fileno())
                if total is not None and existing < total:
                    raise IOError(f"Connection ended early ({existing}/{total} bytes).")
                output.parent.mkdir(parents=True, exist_ok=True)
                partial.replace(output)
                shutil.rmtree(root, ignore_errors=True)
                return
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError, IncompleteRead) as exc:
            append_job_log(job_id, f"Direct retry {attempt + 1}/{retries}: {exc}")
            if attempt + 1 >= retries:
                raise RuntimeError(f"Direct download failed after {retries} attempts: {exc}") from exc
            retry_sleep(attempt)


def run_direct(job_id: str, payload: dict[str, Any]) -> None:
    url = str(payload["url"])
    referrer = str(payload.get("referrer") or "")
    headers = safe_request_headers(payload.get("headers"), referrer)
    output = Path(JOBS[job_id].output)
    root = Path(str(payload["_cache_root"]))
    update_job(job_id, status="running", mode="direct", attempt=1, cache_path=str(root))
    try:
        probe = probe_remote(url, headers)
        url = str(probe.get("final_url") or url)
        prepare_cache_root(root, probe, payload)
        if probe.get("ranges") and probe.get("total") and int(probe["total"]) >= 8 * 1024 * 1024:
            try:
                run_chunked_direct(job_id, url, headers, output, probe, root)
            except RangeUnsupported as exc:
                append_job_log(job_id, f"Range cache unavailable, falling back to sequential cache: {exc}")
                shutil.rmtree(root / "chunks", ignore_errors=True)
                run_sequential_direct(job_id, url, headers, output, probe, root)
        else:
            run_sequential_direct(job_id, url, headers, output, probe, root)
        update_job(job_id, status="completed", progress=100.0, output=str(output), eta=0.0, speed=0.0)
    except Exception as exc:  # noqa: BLE001
        update_job(job_id, status="failed", error=str(exc))
        if not bool(CONFIG.get("keep_failed_cache", True)):
            shutil.rmtree(root, ignore_errors=True)



def parse_requested_range(value: str) -> tuple[int, int | None] | None:
    match = re.fullmatch(r"bytes=(\d+)-(\d*)", str(value or "").strip(), re.IGNORECASE)
    if not match:
        return None
    start = int(match.group(1))
    end = int(match.group(2)) if match.group(2) else None
    if end is not None and end < start:
        return None
    return start, end


def segment_sequence_from_url(url: str) -> int | None:
    try:
        parsed = urllib.parse.urlsplit(url)
        path = urllib.parse.unquote(parsed.path)
        name = Path(path).name
        match = re.search(r"(?:(?:file)?seq(?:uence)?|seg(?:ment)?|chunk|frag(?:ment)?|part)[-_.]?(\d{1,14})", path, re.IGNORECASE)
        if not match:
            match = re.search(r"(?:^|[-_.])(\d{1,14})(?=\.[^.]+$)", name, re.IGNORECASE)
        if not match:
            match = re.search(r"/(\d{1,14})(?:/)?$", path)
        if match:
            return int(match.group(1))
        for key, value in urllib.parse.parse_qsl(parsed.query, keep_blank_values=True):
            if re.fullmatch(r"(?:seg(?:ment)?|seg(?:ment)?number|seq(?:uence)?|sq|sn|chunk|frag(?:ment)?|part|number|start|offset|_HLS_msn|_HLS_part)", key, re.IGNORECASE) and value.isdigit():
                return int(value)
    except Exception:  # noqa: BLE001
        return None
    return None


def normalize_segment_entries(raw_entries: Any, common_headers: Any = None, common_referrer: str = "") -> list[dict[str, Any]]:
    if not isinstance(raw_entries, list):
        return []
    limit = max(1, min(24_000, int(CONFIG.get("captured_fragment_limit", 12_000))))
    base_headers = safe_request_headers(common_headers if isinstance(common_headers, dict) else {}, common_referrer)
    unique: dict[str, dict[str, Any]] = {}
    for fallback_order, raw in enumerate(raw_entries[:limit]):
        if not isinstance(raw, dict):
            continue
        try:
            url = validate_remote_url(str(raw.get("url") or ""))
        except ValueError:
            continue
        referrer = str(raw.get("referrer") or common_referrer or "")
        headers = dict(base_headers)
        headers.update(safe_request_headers(raw.get("headers") if isinstance(raw.get("headers"), dict) else {}, referrer))
        explicit_range = str(raw.get("range") or "").strip()
        if explicit_range:
            headers["Range"] = explicit_range
        range_value = headers.get("Range", "")
        key = f"{url}|{range_value}"
        supplied_sequence = raw.get("sequence")
        try:
            sequence = int(supplied_sequence) if supplied_sequence is not None and str(supplied_sequence) != "" else segment_sequence_from_url(url)
        except (TypeError, ValueError):
            sequence = segment_sequence_from_url(url)
        supplied_order = raw.get("order", raw.get("createdAt", fallback_order))
        try:
            order = float(supplied_order)
        except (TypeError, ValueError):
            order = float(fallback_order)
        unique[key] = {
            "url": url,
            "headers": headers,
            "range": range_value,
            "sequence": sequence,
            "init": bool(raw.get("init")),
            "mime": str(raw.get("mime") or ""),
            "size": int(raw.get("size")) if str(raw.get("size") or "").isdigit() else None,
            "order": order,
        }
    entries = list(unique.values())
    ranged_urls = {entry["url"] for entry in entries if entry["range"]}
    entries = [entry for entry in entries if entry["range"] or entry["url"] not in ranged_urls]
    has_sequences = any(not entry["init"] and entry["sequence"] is not None for entry in entries)

    def sort_key(item: dict[str, Any]) -> tuple[Any, ...]:
        if has_sequences:
            if item["init"]:
                return (0, item["order"], item["url"], item["range"])
            if item["sequence"] is not None:
                return (1, int(item["sequence"]), item["order"], item["url"], item["range"])
            return (2, item["order"], item["url"], item["range"])
        return (item["order"], 0 if item["init"] else 1, item["url"], item["range"])

    entries.sort(key=sort_key)
    return entries


def validate_segment_continuity(entries: list[dict[str, Any]]) -> None:
    sequences = sorted({int(entry["sequence"]) for entry in entries if not entry["init"] and entry.get("sequence") is not None})
    if len(sequences) < 2:
        return
    sequence_set = set(sequences)
    missing = [value for value in range(sequences[0], sequences[-1] + 1) if value not in sequence_set]
    if missing:
        preview = ", ".join(str(value) for value in missing[:12])
        suffix = "…" if len(missing) > 12 else ""
        raise RuntimeError(f"Captured fragment family is incomplete; missing sequence numbers: {preview}{suffix}. Replay or seek through the full video, or use Smart Fetch so the manifest can supply every fragment.")


def fragment_suffix(entry: dict[str, Any]) -> str:
    suffix = extension_from_url(str(entry.get("url") or ""))
    if suffix in {".m4s", ".cmfv", ".cmfa", ".ismv", ".isma", ".ts", ".aac", ".mp4", ".m4a", ".webm"}:
        return suffix
    mime = str(entry.get("mime") or "").lower()
    if "mp2t" in mime:
        return ".ts"
    if "audio" in mime:
        return ".m4a"
    return ".m4s"


def expected_fragment_length(entry: dict[str, Any]) -> int | None:
    captured_range = parse_requested_range(str(entry.get("range") or ""))
    if captured_range and captured_range[1] is not None:
        return captured_range[1] - captured_range[0] + 1
    value = entry.get("size")
    try:
        return int(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def probe_stream_types(path: Path) -> set[str]:
    ffprobe = ffprobe_executable()
    if not ffprobe:
        return set()
    try:
        result = subprocess.run(
            [ffprobe, "-v", "error", "-show_entries", "stream=codec_type", "-of", "json", str(path)],
            capture_output=True,
            text=True,
            timeout=45,
            check=False,
        )
        if result.returncode != 0:
            return set()
        data = json.loads(result.stdout or "{}")
        return {str(stream.get("codec_type") or "") for stream in data.get("streams", []) if stream.get("codec_type")}
    except (OSError, subprocess.SubprocessError, json.JSONDecodeError):
        return set()


def captured_track_type(family: dict[str, Any]) -> str:
    text = " ".join([
        str(family.get("mime") or ""),
        str(family.get("family") or ""),
        " ".join(str(entry.get("mime") or "") + " " + str(entry.get("url") or "") for entry in family.get("segments", [])[:8]),
    ]).lower()
    if re.search(r"\baudio\b|audio/|\.cmfa(?:\W|$)|\.isma(?:\W|$)", text):
        return "audio"
    if re.search(r"\bvideo\b|video/|\.cmfv(?:\W|$)|\.ismv(?:\W|$)", text):
        return "video"
    return "unknown"


def download_captured_fragment(job_id: str, entry: dict[str, Any], destination: Path, state: dict[str, Any], lock: threading.Lock) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    partial = destination.with_suffix(destination.suffix + ".partial")
    retries = max(1, int(CONFIG.get("stream_retries", 30)))
    base_headers = dict(entry["headers"])
    captured_range = parse_requested_range(str(entry.get("range") or ""))

    for attempt in range(retries):
        try:
            existing = partial.stat().st_size if partial.exists() else 0
            headers = dict(base_headers)
            expected_length: int | None = entry.get("size")
            request_start = existing
            request_end: int | None = None
            if captured_range:
                absolute_start, absolute_end = captured_range
                expected_length = (absolute_end - absolute_start + 1) if absolute_end is not None else expected_length
                if expected_length is not None and existing >= expected_length:
                    partial.replace(destination)
                    with lock:
                        state["done"] += 1
                        state["bytes"] += destination.stat().st_size
                    return
                request_start = absolute_start + existing
                request_end = absolute_end
                headers["Range"] = f"bytes={request_start}-{'' if request_end is None else request_end}"
            elif existing:
                headers["Range"] = f"bytes={existing}-"

            with open_remote(str(entry["url"]), headers, timeout=45) as response:
                if captured_range and response.status != 206:
                    partial.unlink(missing_ok=True)
                    raise IOError("Server ignored the captured byte range for this fragment.")
                if existing and response.status != 206:
                    partial.unlink(missing_ok=True)
                    raise IOError("Server ignored the fragment resume range; restarting this fragment.")
                content_range = parse_content_range(response.headers.get("Content-Range", ""))
                if response.status == 206 and content_range and content_range[0] != request_start:
                    raise IOError(f"Fragment range mismatch: requested {request_start}, received {content_range[0]}.")
                if expected_length is None:
                    content_length = response.headers.get("Content-Length")
                    if content_length and content_length.isdigit():
                        expected_length = existing + int(content_length)
                mode = "ab" if existing else "wb"
                written = existing
                with partial.open(mode) as target:
                    while True:
                        chunk = response.read(1024 * 1024)
                        if not chunk:
                            break
                        target.write(chunk)
                        written += len(chunk)
                        with lock:
                            state["bytes"] += len(chunk)
                            update_job(job_id, bytes_downloaded=state["bytes"], progress=min(99.0, state["done"] / max(1, state["total"]) * 100.0))
                    target.flush()
                    os.fsync(target.fileno())
                if expected_length is not None and written < expected_length:
                    raise IOError(f"Fragment ended early ({written}/{expected_length} bytes).")
                partial.replace(destination)
                with lock:
                    state["done"] += 1
                    update_job(job_id, bytes_downloaded=state["bytes"], progress=min(99.0, state["done"] / max(1, state["total"]) * 100.0))
                return
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError, IncompleteRead) as exc:
            append_job_log(job_id, f"Fragment retry {attempt + 1}/{retries}: {exc}")
            if attempt + 1 >= retries:
                raise RuntimeError(f"Fragment download failed after {retries} attempts: {entry['url']} ({exc})") from exc
            retry_sleep(attempt, cap=30.0)


def download_captured_family(job_id: str, family: dict[str, Any], family_index: int, root: Path, state: dict[str, Any], lock: threading.Lock) -> Path:
    entries = normalize_segment_entries(family.get("segments"), family.get("headers"), str(family.get("pageUrl") or family.get("referrer") or ""))
    media_entries = [entry for entry in entries if not entry["init"]]
    if not media_entries:
        raise RuntimeError("Captured fragment family contains no media fragments.")
    validate_segment_continuity(entries)
    family_root = root / "captured" / f"track-{family_index:02d}"
    family_root.mkdir(parents=True, exist_ok=True)
    tasks: list[tuple[dict[str, Any], Path]] = []
    ordered_files: list[Path] = []
    for index, entry in enumerate(entries):
        sequence = entry.get("sequence")
        label = "init" if entry["init"] else f"{int(sequence):012d}" if sequence is not None else f"order-{index:012d}"
        digest = hashlib.sha256(f"{stable_url_identity(entry['url'])}|{entry.get('range', '')}".encode("utf-8", errors="replace")).hexdigest()[:12]
        destination = family_root / f"{index:06d}-{label}-{digest}{fragment_suffix(entry)}"
        ordered_files.append(destination)
        if destination.exists():
            expected = expected_fragment_length(entry)
            if expected is not None and destination.stat().st_size != expected:
                destination.unlink(missing_ok=True)
            else:
                with lock:
                    state["done"] += 1
                    state["bytes"] += destination.stat().st_size
                continue
        tasks.append((entry, destination))
    workers = max(1, min(16, int(CONFIG.get("concurrent_fragments", 8))))
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers, thread_name_prefix="ng-segment") as executor:
        futures = [executor.submit(download_captured_fragment, job_id, entry, destination, state, lock) for entry, destination in tasks]
        for future in concurrent.futures.as_completed(futures):
            future.result()

    missing_files = [path for path in ordered_files if not path.exists()]
    if missing_files:
        raise RuntimeError(f"Only {len(ordered_files) - len(missing_files)} of {len(entries)} cached fragments are available.")
    assembled = family_root / "assembled.fragment-stream"
    temp = assembled.with_suffix(".tmp")
    with temp.open("wb") as output_handle:
        for fragment in ordered_files:
            with fragment.open("rb") as source:
                shutil.copyfileobj(source, output_handle, 1024 * 1024)
        output_handle.flush()
        os.fsync(output_handle.fileno())
    temp.replace(assembled)
    return assembled


def normalize_fragment_families(payload: dict[str, Any]) -> list[dict[str, Any]]:
    raw_families = payload.get("fragmentFamilies")
    families: list[dict[str, Any]] = []
    if isinstance(raw_families, list):
        for raw in raw_families[:12]:
            if not isinstance(raw, dict):
                continue
            if raw.get("truncated"):
                raise RuntimeError("The browser capture exceeded its fragment limit. Use Smart Fetch while the manifest is still available, or replay a shorter range of the video.")
            segments = normalize_segment_entries(raw.get("segments"), raw.get("headers"), str(raw.get("pageUrl") or raw.get("referrer") or ""))
            if segments:
                families.append({**raw, "segments": segments})
    if not families:
        if payload.get("segmentsTruncated"):
            raise RuntimeError("The browser capture exceeded its fragment limit. Use Smart Fetch while the manifest is still available, or replay a shorter range of the video.")
        segments = normalize_segment_entries(payload.get("segments"), payload.get("segmentHeaders"), str(payload.get("referrer") or payload.get("pageUrl") or ""))
        if segments:
            families.append({
                "family": str(payload.get("cacheKey") or "captured"),
                "mime": str(payload.get("mime") or ""),
                "headers": payload.get("segmentHeaders") if isinstance(payload.get("segmentHeaders"), dict) else {},
                "pageUrl": str(payload.get("referrer") or payload.get("pageUrl") or ""),
                "segments": segments,
            })
    return families


def run_captured_segments(job_id: str, payload: dict[str, Any]) -> None:
    ffmpeg = ffmpeg_executable()
    if not ffmpeg:
        update_job(job_id, status="failed", error="ffmpeg is required to assemble captured fragments.")
        return
    root = Path(str(payload.get("_cache_root") or CACHE_DIR / "jobs" / stable_cache_key(payload)))
    root.mkdir(parents=True, exist_ok=True)
    families = normalize_fragment_families(payload)
    if not families:
        update_job(job_id, status="failed", error="No captured fragments were supplied. Replay the video, rescan, or use Smart Fetch.")
        return

    def family_weight(family: dict[str, Any]) -> tuple[int, int]:
        return (
            sum(int(entry.get("size") or 0) for entry in family.get("segments", [])),
            len(family.get("segments", [])),
        )

    typed = [(captured_track_type(family), family) for family in families]
    video = sorted((family for kind, family in typed if kind == "video"), key=family_weight, reverse=True)
    audio = sorted((family for kind, family in typed if kind == "audio"), key=family_weight, reverse=True)
    unknown = sorted((family for kind, family in typed if kind == "unknown"), key=family_weight, reverse=True)
    selected: list[dict[str, Any]] = []
    if video:
        selected.append(video[0])
    if audio:
        selected.append(audio[0])
    for family in unknown:
        if family not in selected:
            selected.append(family)
        if len(selected) >= 4:
            break
    if not selected:
        selected = sorted(families, key=family_weight, reverse=True)[:4]

    total_entries = sum(len(family["segments"]) for family in selected)
    state: dict[str, Any] = {"bytes": 0, "done": 0, "total": total_entries}
    lock = threading.Lock()
    update_job(job_id, status="running", mode="segments", backend="captured-fragment-cache", cache_path=str(root), progress=0.0)
    try:
        tracks = [download_captured_family(job_id, family, index, root, state, lock) for index, family in enumerate(selected)]
        track_types = [probe_stream_types(track) for track in tracks]
        output = Path(JOBS[job_id].output)
        temp_output = root / f"assembled.partial{output.suffix}"
        cmd = [ffmpeg, "-hide_banner", "-nostdin", "-y", "-loglevel", "warning", "-fflags", "+genpts"]
        for track in tracks:
            cmd.extend(["-i", str(track)])
        combined_index = next((index for index, kinds in enumerate(track_types) if "video" in kinds and "audio" in kinds), None)
        if combined_index is not None:
            cmd.extend(["-map", f"{combined_index}:v?", "-map", f"{combined_index}:a?", "-map", f"{combined_index}:s?"])
        else:
            video_index = next((index for index, kinds in enumerate(track_types) if "video" in kinds), 0 if tracks else None)
            audio_index = next((index for index, kinds in enumerate(track_types) if "audio" in kinds and index != video_index), None)
            if video_index is not None:
                cmd.extend(["-map", f"{video_index}:v?", "-map", f"{video_index}:a?"])
            if audio_index is not None:
                cmd.extend(["-map", f"{audio_index}:a?"])
            if video_index is None and audio_index is None and tracks:
                cmd.extend(["-map", "0:v?", "-map", "0:a?", "-map", "0:s?"])
        cmd.extend(["-c", "copy", str(temp_output)])
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=None, check=False)
        if result.returncode != 0 or not temp_output.exists() or temp_output.stat().st_size == 0:
            detail = (result.stderr or result.stdout or "ffmpeg could not parse the cached fragment stream.").strip().splitlines()[-1]
            raise RuntimeError(detail)
        output.parent.mkdir(parents=True, exist_ok=True)
        temp_output.replace(output)
        output_streams = probe_stream_types(output)
        if ffprobe_executable() and not ({"video", "audio"} & output_streams):
            output.unlink(missing_ok=True)
            raise RuntimeError("The assembled output contains no playable audio or video stream.")
        update_job(job_id, status="completed", backend="captured-fragment-cache", progress=100.0, eta=0.0, output=str(output))
        shutil.rmtree(root, ignore_errors=True)
    except Exception as exc:  # noqa: BLE001
        update_job(job_id, status="failed", error=f"Captured-fragment assembly failed: {exc}")
        append_job_log(job_id, str(exc))
        if not bool(CONFIG.get("keep_failed_cache", True)):
            shutil.rmtree(root, ignore_errors=True)

def ytdlp_output_template(job_id: str, payload: dict[str, Any], site_mode: bool) -> str:
    selected = Path(JOBS[job_id].output)
    base = sanitize_filename(selected.stem)
    if site_mode:
        return f"{base} [%(id)s].%(ext)s"
    return f"{base}.%(ext)s"


def normalize_fallback_candidates(payload: dict[str, Any]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    raw_candidates = payload.get("fallbackCandidates")
    if not isinstance(raw_candidates, list):
        return result
    for raw in raw_candidates[:16]:
        if not isinstance(raw, dict):
            continue
        try:
            url = validate_remote_url(str(raw.get("url") or ""))
        except ValueError:
            continue
        kind = str(raw.get("kind") or "video").lower()
        if kind not in {"video", "audio", "hls", "dash", "file", "segments"}:
            continue
        result.append({
            "url": url,
            "kind": kind,
            "title": str(raw.get("title") or payload.get("title") or "media"),
            "mime": str(raw.get("mime") or ""),
            "referrer": str(raw.get("referrer") or payload.get("referrer") or ""),
            "headers": raw.get("headers") if isinstance(raw.get("headers"), dict) else {},
        })
    return result


def build_ytdlp_command(job_id: str, payload: dict[str, Any], target: dict[str, Any], cache_path: Path, site_mode: bool) -> list[str]:
    command = ytdlp_command()
    if not command:
        raise RuntimeError("yt-dlp is not installed. Run setup_companion.ps1.")
    container = str(payload.get("container") or "mkv").lower()
    if container not in {"mkv", "mp4", "webm"}:
        container = "mkv"
    referrer = str(target.get("referrer") or payload.get("referrer") or "")
    headers = safe_request_headers(target.get("headers") or payload.get("headers"), referrer)
    cmd = [
        *command,
        "--newline",
        "--no-playlist",
        "--no-allow-unplayable-formats",
        "--continue",
        "--part",
        "--abort-on-unavailable-fragments",
        "--keep-fragments",
        "--hls-use-mpegts",
        "--downloader", "dash,m3u8:native",
        "--retries", str(max(1, int(CONFIG.get("stream_retries", 30)))),
        "--fragment-retries", str(max(1, int(CONFIG.get("stream_retries", 30)))),
        "--extractor-retries", "8",
        "--file-access-retries", "12",
        "--retry-sleep", "http:exp=1:30",
        "--retry-sleep", "fragment:exp=1:30",
        "--retry-sleep", "extractor:exp=1:20",
        "--retry-sleep", "file_access:linear=1:10:1",
        "--socket-timeout", "35",
        "--concurrent-fragments", str(max(1, min(16, int(CONFIG.get("concurrent_fragments", 8))))),
        "--paths", str(OUTPUT_DIR),
        "--paths", f"temp:{cache_path}",
        "--cache-dir", str(CACHE_DIR / "yt-dlp"),
        "--output", ytdlp_output_template(job_id, payload, site_mode),
        "--merge-output-format", container,
        "--windows-filenames",
        "--trim-filenames", "180",
        "--format", "bv*+ba/b",
        "--print", "after_move:__NEBULA_OUTPUT__:%(filepath)s",
    ]
    if bool(CONFIG.get("impersonate_generic", True)) and ytdlp_impersonation_available():
        cmd.extend(["--extractor-args", "generic:impersonate=chrome"])
    cookies_browser = str(payload.get("cookiesFromBrowser") or "").strip().lower()
    if cookies_browser and not any(key.lower() == "cookie" for key in headers):
        browser_base = cookies_browser.split("+", 1)[0].split(":", 1)[0]
        if browser_base not in BROWSER_NAMES:
            raise ValueError("Unsupported browser cookie source.")
        cmd.extend(["--cookies-from-browser", cookies_browser])
    if referrer.startswith(("http://", "https://")):
        cmd.extend(["--referer", referrer])
    for key, value in headers.items():
        if key.lower() in {"accept-encoding", "referer"}:
            continue
        cmd.extend(["--add-headers", f"{key}:{value}"])
    cmd.append(str(target["url"]))
    return cmd


def run_ytdlp_process(job_id: str, cmd: list[str], attempt: int, backend: str) -> tuple[bool, str]:
    update_job(job_id, status="running", backend=backend, attempt=attempt, error="")
    process = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
    )
    assert process.stdout is not None
    last_line = ""
    for line in process.stdout:
        last_line = line.strip() or last_line
        append_job_log(job_id, line)
        output_match = re.search(r"__NEBULA_OUTPUT__:(.+)$", line.strip())
        if output_match:
            update_job(job_id, output=output_match.group(1).strip())
        percent_match = re.search(r"\[download\]\s+(\d+(?:\.\d+)?)%", line)
        if percent_match:
            update_job(job_id, progress=min(100.0, float(percent_match.group(1))))
        eta_match = re.search(r"ETA\s+(\d+):(\d+)(?::(\d+))?", line)
        if eta_match:
            values = [int(value or 0) for value in eta_match.groups()]
            eta = values[0] * 60 + values[1] if values[2] is None else values[0] * 3600 + values[1] * 60 + values[2]
            update_job(job_id, eta=float(eta))
    code = process.wait()
    return code == 0, last_line or f"yt-dlp exited with code {code}."


def run_ytdlp(job_id: str, payload: dict[str, Any]) -> None:
    if not ytdlp_command():
        update_job(job_id, status="failed", error="yt-dlp is not installed. Run setup_companion.ps1.")
        return

    root = Path(str(payload["_cache_root"]))
    cache_path = root / "yt-dlp"
    cache_path.mkdir(parents=True, exist_ok=True)
    kind = str(payload.get("kind") or "")
    site_mode = kind == "page" or bool(payload.get("pageMode"))
    primary = {
        "url": str(payload["url"]),
        "kind": kind,
        "title": str(payload.get("title") or "media"),
        "mime": str(payload.get("mime") or ""),
        "referrer": str(payload.get("referrer") or ""),
        "headers": payload.get("headers") if isinstance(payload.get("headers"), dict) else {},
    }
    targets = [primary]
    if site_mode:
        targets.extend(normalize_fallback_candidates(payload))

    last_error = "No downloadable media was found."
    max_restarts = max(1, min(8, int(CONFIG.get("job_restarts", 3))))
    try:
        for target_index, target in enumerate(targets):
            target_kind = str(target.get("kind") or "")
            if target_kind in {"hls", "dash"}:
                try:
                    inspection = inspect_stream(str(target["url"]), target_kind, str(target.get("referrer") or ""), target.get("headers") if isinstance(target.get("headers"), dict) else {})
                    if inspection.get("encrypted") or inspection.get("drm"):
                        append_job_log(job_id, f"Skipped encrypted/DRM fallback candidate: {target['url']}")
                        continue
                except Exception as exc:  # noqa: BLE001
                    append_job_log(job_id, f"Skipped unreadable fallback candidate: {exc}")
                    continue
            attempts = max_restarts if target_index == 0 else 1
            for attempt in range(1, attempts + 1):
                backend = "yt-dlp" if target_index == 0 else f"yt-dlp-fallback-{target_index}"
                update_job(job_id, url=str(target["url"]), cache_path=str(root), mode="site" if site_mode else "stream")
                try:
                    cmd = build_ytdlp_command(job_id, payload, target, cache_path, site_mode)
                    ok, detail = run_ytdlp_process(job_id, cmd, attempt, backend)
                except Exception as exc:  # noqa: BLE001
                    ok, detail = False, str(exc)
                if ok:
                    update_job(job_id, status="completed", progress=100.0, eta=0.0, speed=0.0)
                    shutil.rmtree(root, ignore_errors=True)
                    return
                last_error = detail
                append_job_log(job_id, f"Process attempt {attempt}/{attempts} failed: {detail}")
                if attempt < attempts:
                    retry_sleep(attempt - 1, cap=20.0)
            if target_index == 0 and len(targets) > 1:
                append_job_log(job_id, "Page extractor failed; trying media URLs captured from the active tab.")
        if normalize_fragment_families(payload):
            append_job_log(job_id, "Manifest and page extraction failed; assembling the captured fragment families from the disk-backed segment cache.")
            run_captured_segments(job_id, payload)
            return
        raise RuntimeError(last_error)
    except Exception as exc:  # noqa: BLE001
        update_job(job_id, status="failed", error=f"Cached extraction failed after retries: {exc}")
        if not bool(CONFIG.get("keep_failed_cache", True)):
            shutil.rmtree(root, ignore_errors=True)


def run_ffmpeg_stream(job_id: str, payload: dict[str, Any]) -> None:
    ffmpeg = ffmpeg_executable()
    if not ffmpeg:
        update_job(job_id, status="failed", error="ffmpeg is not installed or not on PATH.")
        return

    url = str(payload["url"])
    kind = str(payload.get("kind") or "")
    referrer = str(payload.get("referrer") or "")
    headers = safe_request_headers(payload.get("headers"), referrer)
    root = Path(str(payload.get("_cache_root") or CACHE_DIR / "jobs" / stable_cache_key(payload)))
    root.mkdir(parents=True, exist_ok=True)
    try:
        inspection = inspect_stream(url, kind, referrer, headers)
        if inspection.get("encrypted") or inspection.get("drm"):
            raise ValueError("The stream uses encryption or DRM and was rejected.")
    except Exception as exc:  # noqa: BLE001
        update_job(job_id, status="failed", error=str(exc))
        return

    output = Path(JOBS[job_id].output)
    temp_output = root / f"stream.partial{output.suffix}"
    header_blob = "".join(f"{key}: {value}\r\n" for key, value in headers.items() if key.lower() not in {"accept-encoding", "user-agent", "referer"})
    base_cmd = [
        ffmpeg, "-hide_banner", "-nostdin", "-y", "-loglevel", "info",
        "-rw_timeout", "30000000",
        "-reconnect_on_network_error", "1",
        "-reconnect_on_http_error", "429,5xx",
        "-reconnect_streamed", "1",
        "-reconnect_at_eof", "1",
        "-reconnect_delay_max", "30",
        "-reconnect_delay_total_max", "900",
        "-respect_retry_after", "1",
        "-seg_max_retry", str(max(1, int(CONFIG.get("stream_retries", 30)))),
        "-user_agent", headers.get("User-Agent", USER_AGENT),
    ]
    if referrer.startswith(("http://", "https://")):
        base_cmd.extend(["-referer", referrer])
    if header_blob:
        base_cmd.extend(["-headers", header_blob])
    base_cmd.extend(["-i", url, "-map", "0:v?", "-map", "0:a?", "-map", "0:s?", "-c", "copy", str(temp_output)])

    attempts = max(1, min(8, int(CONFIG.get("job_restarts", 3))))
    last_error = "ffmpeg failed."
    for attempt in range(1, attempts + 1):
        update_job(job_id, status="running", mode="stream", backend="ffmpeg-fallback", cache_path=str(root), attempt=attempt, error="")
        try:
            process = subprocess.Popen(
                base_cmd,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                errors="replace",
                creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
            )
            assert process.stderr is not None
            duration: float | None = None
            for line in process.stderr:
                append_job_log(job_id, line)
                duration_match = re.search(r"Duration:\s*(\d+:\d+:\d+(?:\.\d+)?)", line)
                if duration_match and duration is None:
                    duration = parse_timestamp(duration_match.group(1))
                    update_job(job_id, duration=duration)
                time_match = re.search(r"time=(\d+:\d+:\d+(?:\.\d+)?)", line)
                if time_match:
                    position = parse_timestamp(time_match.group(1))
                    progress = min(100.0, max(0.0, position / duration * 100.0)) if position is not None and duration else None
                    update_job(job_id, position=position, progress=progress)
            code = process.wait()
            if code != 0:
                raise RuntimeError(f"ffmpeg exited with code {code}.")
            output.parent.mkdir(parents=True, exist_ok=True)
            temp_output.replace(output)
            update_job(job_id, status="completed", progress=100.0, eta=0.0)
            shutil.rmtree(root, ignore_errors=True)
            return
        except Exception as exc:  # noqa: BLE001
            last_error = str(exc)
            append_job_log(job_id, f"ffmpeg fallback attempt {attempt}/{attempts} failed: {exc}")
            if attempt < attempts:
                retry_sleep(attempt - 1, cap=20.0)
    update_job(job_id, status="failed", error=last_error)
    if not bool(CONFIG.get("keep_failed_cache", True)):
        shutil.rmtree(root, ignore_errors=True)


def choose_filename(payload: dict[str, Any], kind: str, container: str) -> str:
    title = sanitize_filename(str(payload.get("title") or payload.get("filename") or "media"))
    if kind in {"hls", "dash", "segments", "page"}:
        return f"{strip_known_extension(title)}.{container}"
    suffix = Path(title).suffix or extension_from_mime(str(payload.get("mime") or "")) or extension_from_url(str(payload.get("url") or ""))
    if not suffix:
        suffix = {"video": ".mp4", "audio": ".mp3", "image": ".jpg"}.get(kind, ".bin")
    return f"{strip_known_extension(title)}{suffix}"


def start_job(payload: dict[str, Any]) -> Job:
    url = validate_remote_url(str(payload.get("url") or ""))
    kind = str(payload.get("kind") or "").lower()
    if kind not in {"image", "video", "audio", "hls", "dash", "segments", "page", "file", ""}:
        raise ValueError("Unsupported media kind.")
    container = str(payload.get("container") or "mkv").lower()
    if container not in {"mkv", "mp4", "webm"}:
        raise ValueError("Container must be mkv, mp4, or webm.")
    normalized_payload = {**payload, "url": url, "kind": kind}
    cache_key = stable_cache_key(normalized_payload)
    root = CACHE_DIR / "jobs" / cache_key

    filename = choose_filename(normalized_payload, kind, container)
    mode = "site" if kind == "page" or payload.get("pageMode") else "segments" if kind == "segments" else "stream" if kind in {"hls", "dash"} else "direct"
    with JOBS_LOCK:
        for existing in JOBS.values():
            if existing.cache_key == cache_key and existing.status in {"queued", "running"}:
                return existing
        output = unique_output(filename)
        job_id = secrets.token_hex(8)
        job = Job(id=job_id, url=url, output=str(output), mode=mode, cache_path=str(root), cache_key=cache_key)
        JOBS[job_id] = job

    normalized_payload.update({"_cache_root": str(root), "_cache_key": cache_key})
    if mode == "direct":
        target = run_direct
    elif mode == "segments":
        target = run_captured_segments
    elif ytdlp_command():
        target = run_ytdlp
    else:
        target = run_ffmpeg_stream
    thread = threading.Thread(target=target, args=(job_id, normalized_payload), daemon=True, name=f"ng-{mode}-{job_id}")
    thread.start()
    return job


class Handler(BaseHTTPRequestHandler):
    server_version = f"NebulaGrabCompanion/{VERSION}"

    def log_message(self, fmt: str, *args: Any) -> None:
        sys.stdout.write("[%s] %s\n" % (self.log_date_time_string(), fmt % args))

    def send_header(self, keyword: str, value: str) -> None:
        super().send_header(sanitize_header_value(keyword), sanitize_header_value(value))

    def _origin(self) -> str:
        return sanitize_header_value(self.headers.get("Origin", ""))

    def _cors(self) -> None:
        origin = sanitize_header_value(self._origin())
        if is_extension_origin(origin) and origin:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Nebula-Token")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")

    def _json(self, status: int, payload: dict[str, Any]) -> None:
        raw = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self._cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(raw)

    def _authorized(self) -> bool:
        if not is_extension_origin(self._origin()):
            self._json(403, {"error": "Browser origin is not allowed."})
            return False
        supplied = self.headers.get("X-Nebula-Token", "")
        if not supplied or not hmac.compare_digest(supplied, str(CONFIG["token"])):
            self._json(401, {"error": "Invalid companion token."})
            return False
        return True

    def _read_json(self) -> dict[str, Any]:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError as exc:
            raise ValueError("Invalid Content-Length.") from exc
        if length <= 0 or length > MAX_BODY:
            raise ValueError("Request body is empty or too large.")
        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ValueError("Request body is not valid JSON.") from exc
        if not isinstance(payload, dict):
            raise ValueError("JSON body must be an object.")
        return payload

    def do_OPTIONS(self) -> None:  # noqa: N802
        if not is_extension_origin(self._origin()):
            self._json(403, {"error": "Browser origin is not allowed."})
            return
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/health":
            self._json(200, {
                "ok": True,
                "version": VERSION,
                "ffmpeg": bool(ffmpeg_executable()),
                "ytDlp": bool(ytdlp_command()),
                "ytDlpVersion": tool_version(ytdlp_command()),
                "deno": bool(shutil.which("deno")),
                "impersonation": ytdlp_impersonation_available(),
                "ffmpegVersion": tool_version([ffmpeg_executable(), "-version"] if ffmpeg_executable() else None),
                "outputDir": str(OUTPUT_DIR),
                "cacheDir": str(CACHE_DIR),
                "privateNetworkAllowed": ALLOW_PRIVATE,
                "resumableAcrossRestarts": True,
                "contentCategoryFilter": False,
                "capturedFragmentAssembly": True,
                "persistentFragmentCache": True,
                "activeJobs": sum(1 for job in JOBS.values() if job.status in {"queued", "running"}),
            })
            return

        if parsed.path == "/authcheck":
            if not self._authorized():
                return
            self._json(200, {"ok": True, "authorized": True})
            return

        if parsed.path.startswith("/jobs/"):
            if not self._authorized():
                return
            job_id = parsed.path.rsplit("/", 1)[-1]
            with JOBS_LOCK:
                job = JOBS.get(job_id)
                payload = job.public() if job else None
            if not payload:
                self._json(404, {"error": "Job not found."})
            else:
                self._json(200, payload)
            return

        self._json(404, {"error": "Endpoint not found."})

    def do_POST(self) -> None:  # noqa: N802
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path not in {"/download", "/probe"}:
            self._json(404, {"error": "Endpoint not found."})
            return
        if not self._authorized():
            return

        try:
            payload = self._read_json()
            url = validate_remote_url(str(payload.get("url") or ""))
            kind = str(payload.get("kind") or "")
            referrer = str(payload.get("referrer") or "")
            headers = safe_request_headers(payload.get("headers"), referrer)

            if parsed.path == "/probe":
                inspection = inspect_stream(url, kind, referrer, headers)
                self._json(200, {"ok": True, **inspection})
                return

            job = start_job({**payload, "url": url, "headers": payload.get("headers") or {}})
            self._json(202, {"ok": True, "jobId": job.id, "output": job.output, "mode": job.mode})
        except ValueError as exc:
            self._json(400, {"error": str(exc)})
        except Exception as exc:  # noqa: BLE001
            self._json(500, {"error": f"Internal companion error: {exc}"})


def main() -> int:
    parser = argparse.ArgumentParser(description="NebulaGrab resilient local media companion")
    parser.add_argument("--show-token", action="store_true", help="Print the pairing token and exit")
    parser.add_argument("--port", type=int, default=PORT)
    args = parser.parse_args()

    if args.show_token:
        print(CONFIG["token"])
        return 0

    print(f"NebulaGrab Companion v{VERSION}")
    print(f"Listening on http://{HOST}:{args.port}")
    print(f"Output folder: {OUTPUT_DIR}")
    print(f"Cache folder: {CACHE_DIR}")
    print(f"Pairing token: {CONFIG['token']}")
    print(f"ffmpeg: {ffmpeg_executable() or 'NOT FOUND'}")
    print(f"yt-dlp: {tool_version(ytdlp_command()) or 'NOT FOUND'}")
    print(f"Deno: {tool_version([shutil.which('deno'), '--version'] if shutil.which('deno') else None) or 'NOT FOUND'}")
    print("Interrupted downloads keep their disk cache. Start the same download again to resume. Press Ctrl+C to stop.\n")

    server = ThreadingHTTPServer((HOST, args.port), Handler)
    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        print("\nStopping NebulaGrab Companion.")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

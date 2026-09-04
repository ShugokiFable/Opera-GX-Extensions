# NebulaGrab Companion 1.3.0

NebulaGrab Companion is the localhost-only reliability and extraction engine for the Opera GX extension. It handles direct image/audio/video files, unencrypted HLS/DASH, captured segment families, and Smart Fetch page extraction through yt-dlp.

It does not apply content-category filtering. Ordinary and adult sites are treated the same. Access still depends on the site, the authenticated browser session, region, permissions, and whether media is exposed in a downloadable non-DRM form.

## Windows setup

1. Install Python 3.11 or newer.
2. Run `setup_companion.ps1` in PowerShell. It installs or updates the yt-dlp nightly, curl-cffi support, ffmpeg, and Deno.
3. Open a fresh terminal if the installer changed PATH.
4. Run `start_helper.bat`.
5. Copy the pairing token shown in the console.
6. Open NebulaGrab Dashboard → Settings, paste the token, and select **Test companion**.

Downloads go to `%USERPROFILE%\Downloads\NebulaGrab`. Resumable state goes to `%USERPROFILE%\.nebulagrab-cache`.

`config.json` is generated on first run with a unique token. Do not distribute that file. `config.example.json` documents available tuning options.

## Direct-file cache

- Uses stable media fingerprints across helper and browser restarts.
- Splits large range-capable files into independently resumable chunks.
- Falls back to a sequential `.partial` cache when ranges are unavailable.
- Validates size, ETag, and Last-Modified before reusing old cache.
- Flushes data to disk and performs atomic final assembly.

## HLS, DASH, and segmented media

- Uses the yt-dlp nightly because extractors change frequently.
- Forces the native HLS/DASH downloader for VOD fragment continuation.
- Keeps fragments until the final merged output succeeds.
- Uses concurrent fragments, HTTP retries, fragment retries, extractor retries, and process-level restarts.
- Aborts when a required manifest fragment remains unavailable rather than emitting a silently damaged file.
- Preserves request headers, referrers, signed URLs, cookies, and byte ranges captured from the active tab.
- Groups raw `seg-*`, `.ts`, `.m4s`, CMAF, and ISO segment requests into stream families.
- Resumes each captured fragment independently from disk.
- Checks numbered sequences for gaps before assembly.
- Associates initialization fragments with fragmented MP4 media.
- Reconstructs cached fragment streams and remuxes them through ffmpeg without unnecessary re-encoding.
- Can combine separate captured video and audio families.
- Smart Fetch falls back from the page extractor to captured media URLs and then captured fragment families.

A raw fragment-family fallback can only assemble fragments that the browser actually requested. For a full on-demand video, use **Smart Fetch** or play/seek through the complete timeline so every required segment is captured.

## Coverage boundary

No downloader can truthfully guarantee every website. NebulaGrab combines DOM scanning, network capture, yt-dlp extractors, authenticated headers, optional browser cookies, manifest handling, and captured-fragment recovery.

It deliberately does not defeat DRM, obtain protected decryption keys, bypass paywalls, evade account controls, or unlock media the user cannot access. Encrypted HLS and DRM-protected DASH are rejected.

## Security model

- Binds only to `127.0.0.1`.
- Requires a random per-install pairing token.
- Accepts browser calls only from extension origins.
- Rejects non-HTTP(S) URLs and any host whose resolved addresses are not globally routable (`ip.is_global`).
- Reconstructs the fetch URL from parsed scheme/host/port/path/query so the raw user string is never passed to the HTTP client.
- Revalidates redirects (and the final response URL) to reduce SSRF and DNS-rebinding risk.
- Strips CR/LF from every HTTP response header value.
- Redacts Cookie and Authorization values from logs and metadata.
- Sends no browsing or download data to a NebulaGrab cloud service.

Set `NEBULAGRAB_ALLOW_PRIVATE=1` only for trusted private-network development media.

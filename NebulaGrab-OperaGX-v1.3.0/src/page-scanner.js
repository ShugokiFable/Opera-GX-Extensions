'use strict';

const NG_EXTENSIONS = {
  image: /\.(?:jpe?g|png|gif|webp|avif|bmp|svg|ico|jxl)(?:$|[?#])/i,
  video: /\.(?:mp4|webm|mov|m4v|mkv|avi|flv|ogv)(?:$|[?#])/i,
  audio: /\.(?:mp3|m4a|aac|flac|wav|ogg|opus)(?:$|[?#])/i,
  hls: /\.m3u8(?:$|[?#])/i,
  dash: /\.mpd(?:$|[?#])/i,
  segment: /(?:\.(?:m4s|cmfv|cmfa|ismv|isma)(?:$|[?#])|(?:(?:file)?seq(?:uence)?|seg(?:ment)?|chunk|frag(?:ment)?|part)[-_.]?\d+)/i
};

let scanTimer = null;
let lastScanAt = 0;

chrome.runtime.sendMessage({ type: 'PAGE_READY' }).catch(() => {});

window.addEventListener('message', (event) => {
  if (event.source !== window || event.data?.source !== 'NEBULAGRAB_PAGE') return;
  if (event.data.type === 'RESOURCE' && event.data.item) {
    const item = normalizeCandidate(event.data.item);
    if (item) sendItems([item]);
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'SCAN_NOW') {
    const items = scanDocument();
    sendItems(items);
    sendResponse({ count: items.length });
    return;
  }

  if (message?.type === 'DOWNLOAD_BLOB') {
    try {
      const anchor = document.createElement('a');
      anchor.href = message.url;
      anchor.download = String(message.filename || 'media').split('/').pop();
      anchor.rel = 'noopener';
      anchor.style.display = 'none';
      (document.documentElement || document.body).appendChild(anchor);
      anchor.click();
      anchor.remove();
      sendResponse({ started: true });
    } catch (error) {
      sendResponse({ started: false, error: error.message });
    }
  }
});

const observer = new MutationObserver((mutations) => {
  if (!mutations.some((m) => m.addedNodes?.length || m.type === 'attributes')) return;
  clearTimeout(scanTimer);
  scanTimer = setTimeout(() => {
    if (Date.now() - lastScanAt < 600) return;
    const items = scanDocument({ lightweight: true });
    sendItems(items);
  }, 800);
});

function beginObservation() {
  if (!document.documentElement) return setTimeout(beginObservation, 20);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src', 'srcset', 'poster', 'style', 'data-src', 'data-original', 'data-lazy-src']
  });
  setTimeout(() => sendItems(scanDocument()), 250);
}
beginObservation();

function scanDocument(options = {}) {
  lastScanAt = Date.now();
  const candidates = [];
  const seen = new Set();

  const add = (raw) => {
    const item = normalizeCandidate(raw);
    if (!item || seen.has(`${item.kind}|${item.url}`)) return;
    seen.add(`${item.kind}|${item.url}`);
    candidates.push(item);
  };

  for (const img of document.images) {
    const urls = [img.currentSrc, img.src, img.getAttribute('data-src'), img.getAttribute('data-original'), img.getAttribute('data-lazy-src')];
    for (const url of urls) add({ url, kind: 'image', source: 'img', width: img.naturalWidth || img.width, height: img.naturalHeight || img.height, filename: img.alt || '' });
    for (const entry of parseSrcset(img.srcset)) add({ url: entry.url, kind: 'image', source: 'img-srcset', width: entry.width });
  }

  for (const source of document.querySelectorAll('source')) {
    const parentKind = source.parentElement?.tagName === 'PICTURE' ? 'image' : source.parentElement?.tagName === 'AUDIO' ? 'audio' : 'video';
    add({ url: source.src, kind: inferKind(source.src, source.type) || parentKind, mime: source.type, source: 'source' });
    for (const entry of parseSrcset(source.srcset)) add({ url: entry.url, kind: parentKind, mime: source.type, source: 'source-srcset', width: entry.width });
  }

  for (const video of document.querySelectorAll('video')) {
    add({ url: video.currentSrc || video.src, kind: inferKind(video.currentSrc || video.src, video.getAttribute('type')) || 'video', source: 'video', width: video.videoWidth || video.clientWidth, height: video.videoHeight || video.clientHeight, duration: finite(video.duration), filename: video.title || '' });
    add({ url: video.poster, kind: 'image', source: 'video-poster', width: video.videoWidth || video.clientWidth, height: video.videoHeight || video.clientHeight });
  }

  for (const audio of document.querySelectorAll('audio')) {
    add({ url: audio.currentSrc || audio.src, kind: inferKind(audio.currentSrc || audio.src, audio.getAttribute('type')) || 'audio', source: 'audio', duration: finite(audio.duration) });
  }

  for (const anchor of document.querySelectorAll('a[href]')) {
    const href = anchor.href;
    const kind = inferKind(href, anchor.type);
    if (kind) add({ url: href, kind, mime: anchor.type, source: 'link', filename: anchor.getAttribute('download') || anchor.textContent?.trim().slice(0, 80) || '' });
  }

  for (const meta of document.querySelectorAll('meta[property], meta[name]')) {
    const key = (meta.getAttribute('property') || meta.getAttribute('name') || '').toLowerCase();
    if (!/(?:og|twitter):(image|video|audio)/.test(key)) continue;
    const guessed = key.includes('image') ? 'image' : key.includes('audio') ? 'audio' : 'video';
    add({ url: meta.content, kind: inferKind(meta.content, '') || guessed, source: 'metadata' });
  }

  for (const link of document.querySelectorAll('link[href]')) {
    const rel = (link.rel || '').toLowerCase();
    const as = (link.as || '').toLowerCase();
    if (!/(preload|prefetch|icon|image_src)/.test(rel) && !/(image|video|audio)/.test(as)) continue;
    add({ url: link.href, kind: inferKind(link.href, link.type) || (as || (rel.includes('icon') ? 'image' : null)), mime: link.type, source: `link-${rel || as}` });
    for (const entry of parseSrcset(link.imageSrcset || '')) add({ url: entry.url, kind: 'image', source: 'link-srcset', width: entry.width });
  }

  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const data = JSON.parse(script.textContent || 'null');
      walkStructuredData(data, (key, value) => {
        const lower = key.toLowerCase();
        if (!/(contenturl|embedurl|thumbnailurl|image|video|audio|url)/.test(lower)) return;
        const kind = lower.includes('image') || lower.includes('thumbnail') ? 'image' : lower.includes('audio') ? 'audio' : inferKind(value, '') || (lower.includes('video') || lower.includes('content') ? 'video' : null);
        add({ url: value, kind, source: 'json-ld' });
      });
    } catch (_) {}
  }

  const dataElements = document.querySelectorAll('body *');
  const dataLimit = Math.min(dataElements.length, 5000);
  for (let i = 0; i < dataLimit; i += 1) {
    const element = dataElements[i];
    for (const attr of element.attributes || []) {
      if (!/(?:src|url|uri|file|media|video|audio|image|poster|stream|hls|dash|manifest)/i.test(attr.name)) continue;
      for (const url of extractUrls(attr.value)) {
        const hinted = /image|poster|thumb/i.test(attr.name) ? 'image' : /audio/i.test(attr.name) ? 'audio' : /hls/i.test(attr.name) ? 'hls' : /dash|mpd/i.test(attr.name) ? 'dash' : /video|media|stream/i.test(attr.name) ? 'video' : null;
        add({ url, kind: inferKind(url, '') || hinted, source: `attribute-${attr.name}` });
      }
    }
  }

  if (!options.lightweight) {
    let scriptBudget = 2_000_000;
    for (const script of document.querySelectorAll('script:not([src])')) {
      if (scriptBudget <= 0) break;
      const text = String(script.textContent || '').slice(0, scriptBudget).replace(/\\\//g, '/').replace(/\\u002[fF]/g, '/').replace(/&amp;/g, '&');
      scriptBudget -= text.length;
      for (const url of extractUrls(text, 250)) add({ url, kind: inferKind(url, ''), source: 'inline-player-config' });
    }
  }

  if (!options.lightweight) {
    const elements = document.querySelectorAll('body *');
    const max = Math.min(elements.length, 5000);
    for (let i = 0; i < max; i += 1) {
      const style = getComputedStyle(elements[i]);
      for (const prop of ['backgroundImage', 'maskImage', 'borderImageSource']) {
        for (const url of cssUrls(style[prop])) add({ url, kind: 'image', source: `css-${prop}` });
      }
    }
  }

  try {
    for (const entry of performance.getEntriesByType('resource')) {
      const kind = inferKind(entry.name, entry.initiatorType === 'img' ? 'image/*' : '');
      if (kind) add({ url: entry.name, kind, source: `performance-${entry.initiatorType || 'resource'}`, size: finite(entry.transferSize || entry.encodedBodySize) });
    }
  } catch (_) {}

  return candidates;
}

function normalizeCandidate(raw) {
  if (!raw?.url) return null;
  let url;
  try { url = new URL(String(raw.url), location.href).href; } catch (_) { return null; }
  if (/^(data|javascript|chrome|opera|about):/i.test(url)) return null;

  const mime = String(raw.mime || '').split(';')[0].trim();
  const kind = raw.kind || inferKind(url, mime) || (url.startsWith('blob:') ? 'blob' : null);
  if (!kind) return null;
  return {
    url,
    kind,
    mime,
    source: raw.source || 'page',
    pageUrl: location.href,
    filename: cleanFilename(raw.filename || ''),
    width: finite(raw.width),
    height: finite(raw.height),
    duration: finite(raw.duration),
    size: finite(raw.size),
    blobType: raw.blobType || '',
    blobSize: finite(raw.blobSize)
  };
}

function inferKind(url, mime = '') {
  const m = String(mime).toLowerCase();
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  if (/mpegurl/.test(m)) return 'hls';
  if (/dash\+xml/.test(m)) return 'dash';
  if (/(?:video|audio)\/iso\.segment|application\/m4s/.test(m)) return 'segment';
  const value = String(url || '');
  for (const [kind, pattern] of Object.entries(NG_EXTENSIONS)) if (pattern.test(value)) return kind;
  return null;
}

function sendItems(items) {
  if (!items?.length) return;
  chrome.runtime.sendMessage({ type: 'INGEST_ITEMS', items, pageUrl: location.href }).catch(() => {});
}

function parseSrcset(srcset) {
  if (!srcset) return [];
  return srcset.split(',').map((part) => {
    const [url, descriptor] = part.trim().split(/\s+/, 2);
    return { url, width: descriptor?.endsWith('w') ? Number(descriptor.slice(0, -1)) : null };
  }).filter((entry) => entry.url);
}

function cssUrls(value) {
  const urls = [];
  const re = /url\((['"]?)(.*?)\1\)/gi;
  let match;
  while ((match = re.exec(value || ''))) if (match[2]) urls.push(match[2]);
  return urls;
}


function walkStructuredData(value, visitor, key = '') {
  if (typeof value === 'string') { visitor(key, value); return; }
  if (Array.isArray(value)) { for (const entry of value) walkStructuredData(entry, visitor, key); return; }
  if (!value || typeof value !== 'object') return;
  for (const [childKey, child] of Object.entries(value)) walkStructuredData(child, visitor, childKey);
}

function extractUrls(value, limit = 40) {
  const text = String(value || '').trim();
  if (!text) return [];
  const found = [];
  const add = (candidate) => {
    if (!candidate || found.length >= limit) return;
    const clean = candidate.replace(/[\"'<>),;]+$/g, '').replace(/^['"(]+/g, '');
    if (clean && !found.includes(clean)) found.push(clean);
  };
  if (/^(?:https?:|blob:|\/\/|\/)[^\s]+$/i.test(text)) add(text.startsWith('//') ? `${location.protocol}${text}` : text);
  const pattern = /(?:https?:\\?\/\\?\/|\/\/)[^\s"'<>]+?(?:m3u8|mpd|mp4|webm|mov|m4v|mkv|mp3|m4a|aac|flac|ogg|opus|jpe?g|png|gif|webp|avif)(?:\?[^\s"'<>]*)?/gi;
  let match;
  while ((match = pattern.exec(text)) && found.length < limit) add(match[0].replace(/\\//g, '/'));
  return found;
}

function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function cleanFilename(value) {
  return String(value || '').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim().slice(0, 120);
}

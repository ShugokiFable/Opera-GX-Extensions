'use strict';

const DEFAULT_SETTINGS = Object.freeze({
  autoScan: true,
  captureNetwork: true,
  minImageWidth: 96,
  minImageHeight: 96,
  maxItemsPerTab: 1200,
  downloadFolder: 'NebulaGrab',
  helperUrl: 'http://127.0.0.1:17891',
  helperToken: '',
  helperContainer: 'mkv',
  reliableDownloads: true,
  fallbackToBrowser: false,
  smartFetchCookies: false,
  smartFetchBrowser: 'opera',
  clearOnNavigation: true,
  notifications: true
});

const tabStores = new Map();
const persistTimers = new Map();
const requestHeaderStores = new Map();
const requestHeadersById = new Map();
let settingsCache = null;
let injectionLocks = new Set();
const MAX_SEGMENTS_PER_FAMILY = 10000;

const EXTENSIONS = {
  image: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'bmp', 'svg', 'ico', 'jxl'],
  video: ['mp4', 'webm', 'mov', 'm4v', 'mkv', 'avi', 'flv', 'ogv'],
  audio: ['mp3', 'm4a', 'aac', 'flac', 'wav', 'ogg', 'opus'],
  hls: ['m3u8'],
  dash: ['mpd'],
  segment: ['m4s', 'cmfv', 'cmfa', 'ismv', 'isma']
};

const MIME_KIND = [
  [/^image\//i, 'image'],
  [/^video\//i, 'video'],
  [/^audio\//i, 'audio'],
  [/application\/(vnd\.apple\.mpegurl|x-mpegurl)/i, 'hls'],
  [/application\/dash\+xml/i, 'dash']
];

chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.local.get('settings');
  await chrome.storage.local.set({ settings: { ...DEFAULT_SETTINGS, ...(current.settings || {}) } });

  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'nebulagrab-scan', title: 'Scan page with NebulaGrab', contexts: ['page', 'video', 'audio', 'image'] });
    chrome.contextMenus.create({ id: 'nebulagrab-download-target', title: 'Download media with NebulaGrab', contexts: ['video', 'audio', 'image'] });
    chrome.contextMenus.create({ id: 'nebulagrab-smart-fetch', title: 'Smart fetch best page video', contexts: ['page'] });
    chrome.contextMenus.create({ id: 'nebulagrab-open', title: 'Open NebulaGrab dashboard', contexts: ['action'] });
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) return;
  if (info.menuItemId === 'nebulagrab-open') return openDashboard(tab.id);
  if (info.menuItemId === 'nebulagrab-scan') return requestScan(tab.id);
  if (info.menuItemId === 'nebulagrab-smart-fetch') return smartFetchPage(tab.id);
  if (info.menuItemId === 'nebulagrab-download-target' && info.srcUrl) {
    const item = normalizeItem({ url: info.srcUrl, source: 'context-menu', pageUrl: tab.url, tabId: tab.id }, tab.id, 0);
    if (item) await downloadItem(item);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabStores.delete(tabId);
  requestHeaderStores.delete(tabId);
  chrome.storage.session.remove(sessionKey(tabId)).catch(() => {});
});
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    const settings = await getSettings();
    if (settings.clearOnNavigation) clearTab(tabId);
    setBadge(tabId);
  }
});

chrome.webRequest.onBeforeRequest.addListener(
  async (details) => {
    // This fires for every request on every tab. Bail synchronously on the two
    // cheap rejections before awaiting anything, so a page loading 400 assets
    // with capture off does not queue 400 microtasks and a settings read each.
    if (details.tabId < 0) return;
    if (settingsCache && !settingsCache.captureNetwork) return;
    const settings = await getSettings();
    if (!settings.captureNetwork) return;
    await hydrateTab(details.tabId);
    const segment = segmentInfo(details.url);
    const kind = segment ? 'segment' : kindFromUrl(details.url);
    if (!kind) return;
    ingest(details.tabId, [{
      url: details.url,
      kind,
      source: 'network-request',
      frameId: details.frameId,
      initiator: details.initiator || '',
      pageUrl: details.documentUrl || '',
      segmentFamily: segment?.family || '',
      segmentSequence: segment?.sequence ?? null,
      initSegment: Boolean(segment?.init),
      createdAt: numberOrNull(details.timeStamp) || Date.now()
    }]);
  },
  { urls: ['<all_urls>'] }
);

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    if (details.tabId < 0) return;
    const headers = {};
    for (const header of details.requestHeaders || []) {
      const name = String(header.name || '').toLowerCase();
      if (!['accept', 'accept-language', 'authorization', 'cookie', 'origin', 'range', 'referer', 'user-agent', 'x-requested-with', 'sec-fetch-dest', 'sec-fetch-mode', 'sec-fetch-site'].includes(name)) continue;
      const value = header.value || (Array.isArray(header.binaryValue) ? String.fromCharCode(...header.binaryValue) : '');
      if (value) headers[name] = value;
    }
    if (Object.keys(headers).length) {
      storeRequestHeaders(details.tabId, details.url, headers);
      rememberRequestHeaders(details.requestId, headers);
    }
  },
  { urls: ['<all_urls>'], types: ['main_frame', 'sub_frame', 'media', 'xmlhttprequest', 'other'] },
  ['requestHeaders', 'extraHeaders']
);

chrome.webRequest.onHeadersReceived.addListener(
  async (details) => {
    if (details.tabId < 0) return;
    if (settingsCache && !settingsCache.captureNetwork) return;
    const settings = await getSettings();
    if (!settings.captureNetwork) return;

    await hydrateTab(details.tabId);
    const headers = headerMap(details.responseHeaders || []);
    const capturedRequestHeaders = requestHeadersById.get(details.requestId)?.headers || {};
    requestHeadersById.delete(details.requestId);
    const mime = (headers['content-type'] || '').split(';')[0].trim();
    const segment = segmentInfo(details.url, mime);
    const kind = segment ? 'segment' : kindFromMime(mime) || kindFromUrl(details.url);
    if (!kind) return;

    ingest(details.tabId, [{
      url: details.url,
      kind,
      mime,
      size: numberOrNull(headers['content-length']),
      disposition: headers['content-disposition'] || '',
      source: 'network-response',
      frameId: details.frameId,
      pageUrl: details.documentUrl || '',
      statusCode: details.statusCode,
      segmentFamily: segment?.family || '',
      segmentSequence: segment?.sequence ?? null,
      initSegment: Boolean(segment?.init),
      requestHeaders: capturedRequestHeaders,
      createdAt: numberOrNull(details.timeStamp) || Date.now()
    }]);
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders']
);

chrome.webRequest.onErrorOccurred.addListener((details) => requestHeadersById.delete(details.requestId), { urls: ['<all_urls>'] });

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  void handleMessage(message || {}, sender)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
  return true;
});

async function handleMessage(message, sender) {
  switch (message.type) {
    case 'PAGE_READY': {
      if (sender.tab?.id != null) {
        await injectPageHook(sender.tab.id, sender.frameId || 0);
        const settings = await getSettings();
        if (settings.autoScan) {
          try { await chrome.tabs.sendMessage(sender.tab.id, { type: 'SCAN_NOW' }, { frameId: sender.frameId || 0 }); } catch (_) {}
        }
      }
      return {};
    }
    case 'INGEST_ITEMS': {
      if (sender.tab?.id == null) return { count: 0 };
      await hydrateTab(sender.tab.id);
      const count = ingest(sender.tab.id, message.items || [], sender.frameId || 0, sender.tab.url || message.pageUrl || '');
      return { count };
    }
    case 'GET_ACTIVE_TAB': {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      return { tab: tab ? { id: tab.id, title: tab.title, url: tab.url, favIconUrl: tab.favIconUrl } : null };
    }
    case 'GET_ITEMS': {
      const tabId = Number(message.tabId ?? sender.tab?.id);
      await hydrateTab(tabId);
      return { items: getItems(tabId), stats: getStats(tabId) };
    }
    case 'GET_TAB': {
      const tab = await chrome.tabs.get(Number(message.tabId));
      return { tab: { id: tab.id, title: tab.title, url: tab.url, favIconUrl: tab.favIconUrl } };
    }
    case 'SCAN_TAB': {
      await requestScan(Number(message.tabId));
      return {};
    }
    case 'CLEAR_TAB': {
      clearTab(Number(message.tabId));
      return {};
    }
    case 'OPEN_DASHBOARD': {
      await openDashboard(message.tabId);
      return {};
    }
    case 'DOWNLOAD_ITEM': {
      const item = getItemById(Number(message.tabId), message.id) || normalizeItem(message.item || {}, Number(message.tabId), 0);
      if (!item) throw new Error('Media item was not found.');
      return await downloadItem(item);
    }
    case 'SMART_FETCH_PAGE':
      return await smartFetchPage(Number(message.tabId));
    case 'DOWNLOAD_ITEMS': {
      const tabId = Number(message.tabId);
      const ids = Array.isArray(message.ids) ? message.ids : [];
      const items = ids.map((id) => getItemById(tabId, id)).filter(Boolean);
      return await downloadMany(items);
    }
    case 'ANALYZE_MANIFEST': {
      const item = getItemById(Number(message.tabId), message.id);
      if (!item) throw new Error('Manifest item was not found.');
      const analysis = await analyzeManifest(item.url, item.kind);
      patchItem(item.tabId, item.id, analysis);
      return { analysis };
    }
    case 'GET_SETTINGS':
      return { settings: await getSettings() };
    case 'SAVE_SETTINGS': {
      const next = sanitizeSettings(message.settings);
      settingsCache = next;
      await chrome.storage.local.set({ settings: next });
      return { settings: next };
    }
    case 'TEST_HELPER':
      return await helperHealth();
    case 'GET_HELPER_JOB':
      return { job: await helperRequest(`/jobs/${encodeURIComponent(message.jobId)}`, { method: 'GET' }) };
    default:
      return {};
  }
}

const BOOLEAN_SETTINGS = ['autoScan', 'captureNetwork', 'reliableDownloads', 'fallbackToBrowser', 'smartFetchCookies', 'clearOnNavigation', 'notifications'];
const NUMERIC_SETTINGS = { minImageWidth: [0, 8192], minImageHeight: [0, 8192], maxItemsPerTab: [50, 20000] };

// Settings arrived straight from a message and were written through unchecked.
// helperUrl matters most: the companion token is sent to it as a header, so an
// unvalidated value is a place to leak that token to an arbitrary host.
function sanitizeSettings(input) {
  const next = { ...DEFAULT_SETTINGS, ...(input || {}) };

  for (const key of BOOLEAN_SETTINGS) next[key] = Boolean(next[key]);
  for (const [key, [min, max]] of Object.entries(NUMERIC_SETTINGS)) {
    const value = Number(next[key]);
    next[key] = Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : DEFAULT_SETTINGS[key];
  }

  next.downloadFolder = sanitizePathPart(String(next.downloadFolder || '')) || DEFAULT_SETTINGS.downloadFolder;
  next.helperToken = String(next.helperToken || '').trim().slice(0, 512);
  next.helperContainer = /^[a-z0-9]{1,8}$/i.test(String(next.helperContainer || '')) ? String(next.helperContainer).toLowerCase() : DEFAULT_SETTINGS.helperContainer;
  next.smartFetchBrowser = /^[a-z0-9_-]{1,24}$/i.test(String(next.smartFetchBrowser || '')) ? String(next.smartFetchBrowser).toLowerCase() : DEFAULT_SETTINGS.smartFetchBrowser;

  try {
    const url = new URL(String(next.helperUrl || DEFAULT_SETTINGS.helperUrl));
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('bad protocol');
    next.helperUrl = url.origin;
  } catch {
    next.helperUrl = DEFAULT_SETTINGS.helperUrl;
  }

  return next;
}

async function getSettings() {
  if (settingsCache) return settingsCache;
  const result = await chrome.storage.local.get('settings');
  settingsCache = sanitizeSettings(result.settings);
  return settingsCache;
}

// Another context (or a restored profile) can change settings without going
// through SAVE_SETTINGS; without this the worker keeps serving a stale cache.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) settingsCache = sanitizeSettings(changes.settings.newValue);
});

function getStore(tabId) {
  if (!Number.isFinite(tabId)) return null;
  if (!tabStores.has(tabId)) tabStores.set(tabId, { items: new Map(), createdAt: Date.now() });
  return tabStores.get(tabId);
}

function ingest(tabId, rawItems, defaultFrameId = 0, pageUrl = '') {
  const store = getStore(tabId);
  if (!store) return 0;
  let added = 0;
  const maxItems = settingsCache?.maxItemsPerTab || DEFAULT_SETTINGS.maxItemsPerTab;

  for (const raw of rawItems) {
    const item = normalizeItem({ ...raw, pageUrl: raw.pageUrl || pageUrl }, tabId, raw.frameId ?? defaultFrameId);
    if (!item) continue;

    const existing = store.items.get(item.id);
    if (existing) {
      store.items.set(item.id, mergeItems(existing, item));
      continue;
    }

    if (store.items.size >= maxItems) {
      const oldestKey = store.items.keys().next().value;
      store.items.delete(oldestKey);
    }
    store.items.set(item.id, item);
    added += 1;
  }
  setBadge(tabId);
  schedulePersist(tabId);
  return added;
}

function normalizeItem(raw, tabId, frameId) {
  if (!raw?.url || typeof raw.url !== 'string') return null;
  const url = raw.url.trim();
  if (!url || /^(data|javascript|chrome|opera|about):/i.test(url)) return null;

  let parsed;
  try { parsed = new URL(url); } catch (_) { return null; }
  if (!['http:', 'https:', 'blob:', 'filesystem:'].includes(parsed.protocol)) return null;

  const mime = String(raw.mime || '').split(';')[0].trim().toLowerCase();
  const segment = segmentInfo(url, mime);
  const kind = raw.kind === 'segment' || segment ? 'segment' : raw.kind || kindFromMime(mime) || kindFromUrl(url) || (parsed.protocol === 'blob:' ? 'blob' : null);
  if (!kind) return null;

  const segmentFamily = kind === 'segment' ? String(raw.segmentFamily || segment?.family || segmentFamilyKey(url)) : '';
  const segmentSequence = kind === 'segment' ? numberOrNull(raw.segmentSequence ?? segment?.sequence) : null;
  const initSegment = kind === 'segment' && Boolean(raw.initSegment ?? segment?.init);
  const id = hashString(kind === 'segment' ? `segment|${segmentFamily}` : `${kind}|${url}`);
  const segmentEntry = kind === 'segment' ? [{
    url,
    sequence: segmentSequence,
    init: initSegment,
    mime,
    size: numberOrNull(raw.size),
    order: numberOrNull(raw.segmentOrder ?? raw.createdAt) || Date.now(),
    createdAt: numberOrNull(raw.createdAt) || Date.now(),
    headers: raw.requestHeaders && typeof raw.requestHeaders === 'object' ? raw.requestHeaders : {}
  }] : [];
  return {
    id,
    tabId,
    frameId: Number(frameId || 0),
    url,
    kind,
    mime,
    source: raw.source || 'page',
    pageUrl: raw.pageUrl || '',
    initiator: raw.initiator || '',
    filename: raw.filename || (kind === 'segment' ? segmentFilename(url) : filenameFromUrl(url, kind)),
    width: numberOrNull(raw.width),
    height: numberOrNull(raw.height),
    duration: numberOrNull(raw.duration),
    size: numberOrNull(raw.size),
    bitrate: numberOrNull(raw.bitrate),
    disposition: raw.disposition || '',
    statusCode: numberOrNull(raw.statusCode),
    blobType: raw.blobType || '',
    blobSize: numberOrNull(raw.blobSize),
    encrypted: Boolean(raw.encrypted),
    drm: Boolean(raw.drm),
    manifestAnalyzed: Boolean(raw.manifestAnalyzed),
    variants: Array.isArray(raw.variants) ? raw.variants : [],
    segmentFamily,
    segmentSequence,
    initOnly: initSegment,
    segmentUrls: segmentEntry,
    segmentCount: initSegment ? 0 : 1,
    segmentsTruncated: false,
    cacheKey: raw.cacheKey || makeStableCacheKey({ ...raw, url: kind === 'segment' ? segmentFamily : url, kind }),
    createdAt: raw.createdAt || Date.now()
  };
}

function mergeItems(a, b) {
  const merged = { ...a };
  for (const [key, value] of Object.entries(b)) {
    if (value == null || value === '' || (Array.isArray(value) && !value.length)) continue;
    if (key === 'source') merged.source = [...new Set(`${merged.source || ''},${value}`.split(',').map((part) => part.trim()).filter(Boolean))].join(', ');
    else if (key === 'segmentUrls') {
      const combined = mergeSegmentEntries([...(a.segmentUrls || []), ...value]);
      merged.segmentsTruncated = combined.length > MAX_SEGMENTS_PER_FAMILY || Boolean(a.segmentsTruncated || b.segmentsTruncated);
      merged.segmentUrls = combined.slice(0, MAX_SEGMENTS_PER_FAMILY);
      merged.segmentCount = merged.segmentUrls.filter((entry) => !entry.init).length;
      merged.initOnly = merged.segmentCount === 0;
    } else if ((key === 'segmentCount' || key === 'initOnly') && a.kind === 'segment') {
      // Recomputed from the merged segmentUrls array.
    } else if (key === 'segmentsTruncated' && a.kind === 'segment') {
      merged.segmentsTruncated = Boolean(merged.segmentsTruncated || a.segmentsTruncated || value);
    } else if (key === 'url' && a.kind === 'segment') {
      // Keep the first representative URL; the complete ordered family is in segmentUrls.
    } else if (key === 'width' || key === 'height' || key === 'size' || key === 'bitrate') merged[key] = Math.max(Number(a[key] || 0), Number(value || 0)) || null;
    else merged[key] = value;
  }
  return merged;
}

function getItems(tabId) {
  const store = tabStores.get(tabId);
  if (!store) return [];
  return [...store.items.values()].filter((item) => !item.initOnly).sort(compareItems);
}

function getStoredItems(tabId) {
  const store = tabStores.get(tabId);
  return store ? [...store.items.values()] : [];
}

function getStats(tabId) {
  const items = getItems(tabId);
  const stats = { total: items.length, image: 0, video: 0, audio: 0, hls: 0, dash: 0, segment: 0, blob: 0 };
  for (const item of items) stats[item.kind] = (stats[item.kind] || 0) + 1;
  return stats;
}

function compareItems(a, b) {
  const score = (item) => {
    const area = (item.width || 0) * (item.height || 0);
    const typeWeight = ['video', 'hls', 'dash', 'segment', 'audio', 'image', 'blob'].indexOf(item.kind);
    return area + (item.size || 0) / 100 + Math.max(0, 8 - typeWeight) * 1e12;
  };
  return score(b) - score(a) || b.createdAt - a.createdAt;
}

function getItemById(tabId, id) {
  return tabStores.get(tabId)?.items.get(id) || null;
}

function patchItem(tabId, id, patch) {
  const store = tabStores.get(tabId);
  const item = store?.items.get(id);
  if (item) store.items.set(id, { ...item, ...patch });
}

function clearTab(tabId) {
  tabStores.delete(tabId);
  requestHeaderStores.delete(tabId);
  chrome.storage.session.remove(sessionKey(tabId)).catch(() => {});
  setBadge(tabId);
}

function sessionKey(tabId) { return `tab_${tabId}`; }

async function hydrateTab(tabId) {
  if (!Number.isFinite(tabId) || tabStores.has(tabId)) return;
  try {
    const key = sessionKey(tabId);
    const stored = await chrome.storage.session.get(key);
    const list = Array.isArray(stored[key]) ? stored[key] : [];
    const store = { items: new Map(), createdAt: Date.now() };
    for (const item of list) if (item?.id) store.items.set(item.id, item);
    tabStores.set(tabId, store);
    setBadge(tabId);
  } catch (_) {
    tabStores.set(tabId, { items: new Map(), createdAt: Date.now() });
  }
}

function schedulePersist(tabId) {
  clearTimeout(persistTimers.get(tabId));
  persistTimers.set(tabId, setTimeout(async () => {
    persistTimers.delete(tabId);
    const items = getStoredItems(tabId);
    try { await chrome.storage.session.set({ [sessionKey(tabId)]: items }); } catch (_) {}
  }, 250));
}

async function requestScan(tabId) {
  if (!Number.isFinite(tabId)) throw new Error('No active tab was found.');
  try {
    const frames = await chrome.webNavigation.getAllFrames({ tabId });
    const targets = frames?.length ? frames : [{ frameId: 0 }];
    const results = await Promise.allSettled(targets.map((frame) =>
      chrome.tabs.sendMessage(tabId, { type: 'SCAN_NOW' }, { frameId: frame.frameId })
    ));
    if (!results.some((result) => result.status === 'fulfilled')) throw new Error('No injectable frame found.');
  } catch (error) {
    throw new Error('This page cannot be scanned. Browser-internal pages block extensions.');
  }
}

async function injectPageHook(tabId, frameId) {
  const key = `${tabId}:${frameId}`;
  if (injectionLocks.has(key)) return;
  injectionLocks.add(key);
  try {
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      files: ['src/page-hook.js'],
      world: 'MAIN',
      injectImmediately: true
    });
  } catch (_) {
    // Restricted browser pages and some sandboxed frames cannot be injected.
  } finally {
    setTimeout(() => injectionLocks.delete(key), 1500);
  }
}

async function downloadItem(item) {
  if (item.drm || item.encrypted) throw new Error('This stream is encrypted or DRM-protected and is not downloadable by NebulaGrab.');

  if (item.kind === 'segment') {
    const relatedManifest = getRelatedManifest(item);
    if (relatedManifest) return downloadItem(relatedManifest);
    return sendToHelper(item, 'segments');
  }

  if (item.kind === 'hls' || item.kind === 'dash') {
    let analysis = item;
    if (!item.manifestAnalyzed) {
      try {
        analysis = { ...item, ...(await analyzeManifest(item.url, item.kind)) };
        patchItem(item.tabId, item.id, analysis);
      } catch (_) {
        // Authenticated manifests may reject extension-origin fetches. The localhost helper
        // receives the transient request headers and performs the same DRM inspection there.
        analysis = item;
      }
    }
    if (analysis.drm || analysis.encrypted) throw new Error('The manifest uses encryption or DRM and was rejected.');
    return sendToHelper(analysis);
  }

  if (item.url.startsWith('blob:')) {
    if (item.blobType === 'MediaSource') throw new Error('This is a MediaSource stream. Use the detected HLS/DASH manifest instead.');
    try {
      await chrome.tabs.sendMessage(item.tabId, {
        type: 'DOWNLOAD_BLOB',
        url: item.url,
        filename: buildFilename(item)
      }, { frameId: item.frameId || 0 });
      return { mode: 'blob', started: true };
    } catch (_) {
      throw new Error('The page no longer owns this blob URL. Reload the page and scan again.');
    }
  }

  const settings = await getSettings();
  if (settings.reliableDownloads && settings.helperToken) {
    try {
      return await sendToHelper(item, 'direct');
    } catch (error) {
      if (!settings.fallbackToBrowser) throw error;
    }
  }

  const filename = buildFilename(item);
  const downloadId = await chrome.downloads.download({
    url: item.url,
    filename,
    conflictAction: 'uniquify',
    saveAs: false
  });
  return { mode: 'browser', downloadId };
}

async function downloadMany(items) {
  const results = [];
  const queue = [...items];
  const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      try { results.push({ id: item.id, ok: true, ...(await downloadItem(item)) }); }
      catch (error) { results.push({ id: item.id, ok: false, error: error.message }); }
    }
  });
  await Promise.all(workers);
  return { results };
}

async function analyzeManifest(url, kind) {
  const response = await fetch(url, { credentials: 'include', cache: 'no-store', redirect: 'follow' });
  if (!response.ok) throw new Error(`Manifest fetch failed with HTTP ${response.status}.`);
  const text = (await response.text()).slice(0, 4_000_000);

  if (kind === 'hls') return analyzeHls(text, url);
  return analyzeDash(text, url);
}

function analyzeHls(text, baseUrl) {
  const encrypted = /#EXT-X-KEY\s*:[^\n]*METHOD\s*=\s*(?!NONE)/i.test(text) || /SAMPLE-AES/i.test(text);
  const drm = /KEYFORMAT\s*=\s*"?(com\.apple\.streamingkeydelivery|urn:uuid:)/i.test(text);
  const lines = text.split(/\r?\n/);
  const variants = [];

  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].startsWith('#EXT-X-STREAM-INF:')) continue;
    const attrs = parseAttributeList(lines[i].slice(lines[i].indexOf(':') + 1));
    let next = i + 1;
    while (next < lines.length && (!lines[next].trim() || lines[next].startsWith('#'))) next += 1;
    if (next >= lines.length) continue;
    const resolution = (attrs.RESOLUTION || '').split('x').map(Number);
    variants.push({
      url: resolveUrl(lines[next].trim(), baseUrl),
      bandwidth: numberOrNull(attrs.BANDWIDTH),
      width: resolution[0] || null,
      height: resolution[1] || null,
      codecs: attrs.CODECS || '',
      name: attrs.NAME || ''
    });
  }

  return { encrypted, drm, manifestAnalyzed: true, variants, mime: 'application/vnd.apple.mpegurl' };
}

function analyzeDash(text, baseUrl) {
  const drm = /<ContentProtection\b/i.test(text) || /urn:uuid:(edef8ba9|9a04f079|e2719d58)/i.test(text) || /cenc:/i.test(text);
  const encrypted = drm;
  const variants = [];
  const re = /<Representation\b([^>]*)>/gi;
  let match;
  while ((match = re.exec(text)) && variants.length < 100) {
    const attrs = parseXmlAttributes(match[1]);
    variants.push({
      id: attrs.id || '',
      bandwidth: numberOrNull(attrs.bandwidth),
      width: numberOrNull(attrs.width),
      height: numberOrNull(attrs.height),
      codecs: attrs.codecs || '',
      mimeType: attrs.mimeType || ''
    });
  }
  return { encrypted, drm, manifestAnalyzed: true, variants, mime: 'application/dash+xml', baseUrl };
}

async function sendToHelper(item, forcedKind = '') {
  const settings = await getSettings();
  const kind = forcedKind === 'direct' ? item.kind : forcedKind || item.kind;
  const segmentFamily = kind === 'segments' ? buildSegmentFamily(item) : null;
  const payload = {
    url: item.url,
    kind,
    pageMode: kind === 'page',
    title: item.filename || filenameFromUrl(item.url, kind),
    filename: item.filename || '',
    mime: item.mime || '',
    referrer: item.pageUrl || item.initiator || '',
    headers: getRequestHeaders(item.tabId, item.url),
    container: settings.helperContainer || 'mkv',
    cacheKey: item.cacheKey || makeStableCacheKey(item),
    size: item.size || item.blobSize || null,
    fallbackCandidates: Array.isArray(item.fallbackCandidates) ? item.fallbackCandidates : [],
    fragmentFamilies: Array.isArray(item.fragmentFamilies) ? item.fragmentFamilies : [],
    segmentHeaders: segmentFamily?.headers || {},
    segments: segmentFamily?.segments || [],
    segmentsTruncated: Boolean(item.segmentsTruncated),
    cookiesFromBrowser: kind === 'page' && settings.smartFetchCookies ? (settings.smartFetchBrowser || 'opera') : ''
  };
  const result = await helperRequest('/download', { method: 'POST', body: JSON.stringify(payload) });
  if (settings.notifications) {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: 'NebulaGrab companion',
      message: `${kind === 'page' ? 'Smart fetch' : kind === 'hls' || kind === 'dash' ? 'Stream' : 'Cached download'} job started: ${result.jobId || 'queued'}`
    });
  }
  return { mode: 'helper', ...result };
}

async function smartFetchPage(tabId) {
  if (!Number.isFinite(tabId)) throw new Error('No active tab was found.');
  const settings = await getSettings();
  if (!settings.helperToken) throw new Error('Smart Fetch requires the NebulaGrab Companion token in Settings.');
  const tab = await chrome.tabs.get(tabId);
  if (!tab?.url?.startsWith('http')) throw new Error('This page cannot be sent to Smart Fetch.');
  await hydrateTab(tabId);
  const fallbackCandidates = getItems(tabId)
    .filter((item) => ['video', 'audio', 'hls', 'dash'].includes(item.kind) && !item.drm && !item.encrypted && item.url.startsWith('http'))
    .slice(0, 16)
    .map((item) => ({
      url: item.url,
      kind: item.kind,
      title: item.filename || tab.title || 'page-video',
      mime: item.mime || '',
      referrer: item.pageUrl || item.initiator || tab.url,
      headers: getRequestHeaders(tabId, item.url)
    }));
  const fragmentFamilies = getItems(tabId)
    .filter((item) => item.kind === 'segment' && item.segmentCount > 0)
    .slice(0, 12)
    .map((item) => {
      const family = buildSegmentFamily(item);
      return {
        family: item.segmentFamily,
        title: item.filename || tab.title || 'segmented-stream',
        mime: item.mime || '',
        pageUrl: item.pageUrl || tab.url,
        headers: family.headers,
        segments: family.segments,
        truncated: Boolean(item.segmentsTruncated)
      };
    });
  return sendToHelper({
    tabId,
    url: tab.url,
    kind: 'page',
    filename: tab.title || 'page-video',
    pageUrl: tab.url,
    initiator: tab.url,
    cacheKey: makeStableCacheKey({ url: tab.url, pageUrl: tab.url, kind: 'page', filename: tab.title || 'page-video' }),
    fallbackCandidates,
    fragmentFamilies
  }, 'page');
}

async function helperHealth() {
  const health = await helperRequest('/health', { method: 'GET', auth: false });
  const settings = await getSettings();
  if (settings.helperToken) await helperRequest('/authcheck', { method: 'GET' });
  return { helper: health };
}

async function helperRequest(path, options = {}) {
  const settings = await getSettings();
  const base = String(settings.helperUrl || DEFAULT_SETTINGS.helperUrl).replace(/\/$/, '');
  const headers = { 'Content-Type': 'application/json' };
  if (options.auth !== false && settings.helperToken) headers['X-Nebula-Token'] = settings.helperToken;

  let response;
  try {
    response = await fetch(`${base}${path}`, { method: options.method || 'GET', headers, body: options.body });
  } catch (_) {
    throw new Error('NebulaGrab Companion is offline. Start companion/start_helper.bat and configure its token in Settings.');
  }

  let data = {};
  try { data = await response.json(); } catch (_) {}
  if (!response.ok) throw new Error(data.error || `Companion returned HTTP ${response.status}.`);
  return data;
}

function buildFilename(item) {
  const settings = settingsCache || DEFAULT_SETTINGS;
  const folder = sanitizePathPart(settings.downloadFolder || 'NebulaGrab');
  let name = item.filename || filenameFromUrl(item.url, item.kind);
  name = sanitizeFilename(name);
  if (!hasExtension(name)) name += extensionFromMime(item.mime) || extensionFromUrl(item.url) || defaultExtension(item.kind);
  return `${folder}/${name}`;
}

function setBadge(tabId) {
  if (!Number.isFinite(tabId) || tabId < 0) return;
  const count = getItems(tabId).length;
  chrome.action.setBadgeText({ tabId, text: count ? String(Math.min(count, 999)) : '' }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#7c3aed' }).catch(() => {});
}

async function openDashboard(tabId) {
  const url = chrome.runtime.getURL(`ui/dashboard.html${tabId != null ? `?tab=${encodeURIComponent(tabId)}` : ''}`);
  await chrome.tabs.create({ url });
}


function getRelatedManifest(item) {
  const store = tabStores.get(item.tabId);
  if (!store) return null;
  let itemOrigin = '';
  try { itemOrigin = new URL(item.url).origin; } catch (_) {}
  const candidates = [...store.items.values()].filter((candidate) => {
    if (!['hls', 'dash'].includes(candidate.kind) || candidate.drm || candidate.encrypted) return false;
    try {
      const samePage = candidate.pageUrl && item.pageUrl && candidate.pageUrl === item.pageUrl;
      return samePage || new URL(candidate.url).origin === itemOrigin;
    } catch (_) { return false; }
  });
  return candidates.sort(compareItems)[0] || null;
}

function buildSegmentPayload(item) {
  return buildSegmentFamily(item).segments;
}

function buildSegmentFamily(item) {
  const entries = mergeSegmentEntries([...relatedInitEntries(item), ...(Array.isArray(item.segmentUrls) ? item.segmentUrls : [])]);
  const headers = commonSegmentHeaders(entries, getRequestHeaders(item.tabId, item.url));
  const segments = entries.slice(0, MAX_SEGMENTS_PER_FAMILY).map((entry) => ({
    url: entry.url,
    sequence: entry.sequence,
    order: entry.order ?? entry.createdAt ?? null,
    init: Boolean(entry.init),
    mime: entry.mime || item.mime || '',
    size: entry.size || null,
    referrer: item.pageUrl || item.initiator || '',
    range: segmentRange(entry),
    headers: segmentHeaderDiff(entry.headers || {}, headers)
  }));
  return { headers, segments };
}

function relatedInitEntries(item) {
  const store = tabStores.get(item.tabId);
  if (!store) return [];
  let target;
  try { target = new URL(item.url); } catch (_) { return []; }
  const targetDir = target.pathname.slice(0, target.pathname.lastIndexOf('/') + 1);
  const found = [];
  for (const candidate of store.items.values()) {
    if (candidate.kind !== 'segment' || !candidate.initOnly) continue;
    try {
      const parsed = new URL(candidate.url);
      const candidateDir = parsed.pathname.slice(0, parsed.pathname.lastIndexOf('/') + 1);
      if (parsed.origin !== target.origin) continue;
      if (candidate.pageUrl && item.pageUrl && candidate.pageUrl !== item.pageUrl) continue;
      if (candidateDir !== targetDir) continue;
      found.push(...(candidate.segmentUrls || []));
    } catch (_) {}
  }
  return found.slice(0, 8);
}

function compareSegmentEntries(left, right) {
  const leftSequence = Number(left?.sequence);
  const rightSequence = Number(right?.sequence);
  const leftHasSequence = Number.isFinite(leftSequence);
  const rightHasSequence = Number.isFinite(rightSequence);
  if (leftHasSequence || rightHasSequence) {
    if (Boolean(left?.init) !== Boolean(right?.init)) return left?.init ? -1 : 1;
    if (leftHasSequence && rightHasSequence && leftSequence !== rightSequence) return leftSequence - rightSequence;
    if (leftHasSequence !== rightHasSequence) return leftHasSequence ? -1 : 1;
  }
  const leftOrder = Number(left?.order ?? left?.createdAt);
  const rightOrder = Number(right?.order ?? right?.createdAt);
  if (Number.isFinite(leftOrder) && Number.isFinite(rightOrder) && leftOrder !== rightOrder) return leftOrder - rightOrder;
  if (Boolean(left?.init) !== Boolean(right?.init)) return left?.init ? -1 : 1;
  return String(left?.url || '').localeCompare(String(right?.url || '')) || segmentRange(left).localeCompare(segmentRange(right));
}

function segmentRange(entry) {
  return String(entry?.headers?.range || entry?.headers?.Range || entry?.range || '');
}

function mergeSegmentEntries(entries) {
  const exact = new Map();
  for (const raw of entries) {
    if (!raw?.url) continue;
    const entry = { ...raw, headers: { ...(raw.headers || {}) } };
    const key = `${entry.url}|${segmentRange(entry)}`;
    const previous = exact.get(key);
    exact.set(key, previous ? { ...previous, ...entry, headers: { ...previous.headers, ...entry.headers } } : entry);
  }
  const rangedUrls = new Set([...exact.values()].filter((entry) => segmentRange(entry)).map((entry) => entry.url));
  return [...exact.values()]
    .filter((entry) => segmentRange(entry) || !rangedUrls.has(entry.url))
    .sort(compareSegmentEntries);
}

function commonSegmentHeaders(entries, fallback = {}) {
  const allowed = ['accept', 'accept-language', 'authorization', 'cookie', 'origin', 'referer', 'user-agent', 'x-requested-with', 'sec-fetch-dest', 'sec-fetch-mode', 'sec-fetch-site'];
  const candidates = [...entries.map((entry) => entry.headers || {}), fallback || {}];
  const common = {};
  for (const name of allowed) {
    const counts = new Map();
    for (const headers of candidates) {
      const value = headers[name] ?? headers[headerCase(name)];
      if (!value) continue;
      counts.set(String(value), (counts.get(String(value)) || 0) + 1);
    }
    const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (best) common[name] = best[0];
  }
  return common;
}

function segmentHeaderDiff(headers, common) {
  const out = {};
  for (const [rawName, value] of Object.entries(headers || {})) {
    const name = String(rawName).toLowerCase();
    if (!value) continue;
    if (name === 'range' || String(common?.[name] || '') !== String(value)) out[name] = value;
  }
  return out;
}

function headerCase(name) {
  return name.split('-').map((part) => part ? `${part[0].toUpperCase()}${part.slice(1)}` : part).join('-');
}

function segmentFilename(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    return `segmented-stream-${sanitizeFilename(host || 'media')}.mkv`;
  } catch (_) { return 'segmented-stream.mkv'; }
}

function segmentInfo(url, mime = '') {
  let parsed;
  try { parsed = new URL(String(url)); } catch (_) { return null; }
  const path = decodeURIComponent(parsed.pathname || '');
  const name = path.split('/').pop() || '';
  const ext = (name.match(/\.([a-z0-9]{1,8})$/i)?.[1] || '').toLowerCase();
  const lowerMime = String(mime || '').toLowerCase();
  const init = /(?:^|[-_.])(init|initialization)(?:[-_.]|$)/i.test(name) && ['mp4', 'm4s', 'cmfv', 'cmfa', 'ismv', 'isma'].includes(ext);
  const hardSegmentExt = ['m4s', 'cmfv', 'cmfa', 'ismv', 'isma'].includes(ext);
  const namedSegment = /(?:^|[/_.-])(?:(?:file)?seq(?:uence)?|seg(?:ment)?|chunk|frag(?:ment)?|part)[-_.]?(\d{1,14})(?:[/_.-]|$)/i.test(path);
  const segmentDirectory = /\/(?:segments?|chunks?|fragments?|media|dash|hls)\//i.test(path);
  const numericMedia = ['ts', 'mp4', 'm4a', 'aac', 'webm'].includes(ext) && (/(?:^|[/_.-])\d{1,14}\.[a-z0-9]{1,8}$/i.test(path) || segmentDirectory);
  const querySegment = [...parsed.searchParams.entries()].some(([key, value]) => /^(?:seg(?:ment)?|seg(?:ment)?number|seq(?:uence)?|sq|sn|chunk|frag(?:ment)?|part|number|start|offset|_HLS_msn|_HLS_part)$/i.test(key) && /^\d+$/.test(value));
  const mimeSegment = /(?:video|audio)\/iso\.segment|application\/m4s/i.test(lowerMime);
  if (!(init || hardSegmentExt || namedSegment || numericMedia || querySegment || mimeSegment)) return null;

  let sequence = null;
  const pathMatch = path.match(/(?:(?:file)?seq(?:uence)?|seg(?:ment)?|chunk|frag(?:ment)?|part)[-_.]?(\d{1,14})/i)
    || name.match(/(?:^|[-_.])(\d{1,14})(?=\.[^.]+$)/i)
    || path.match(/\/(\d{1,14})(?:\/)?$/);
  if (pathMatch) sequence = Number(pathMatch[1]);
  if (sequence == null) {
    for (const [key, value] of parsed.searchParams.entries()) {
      if (/^(?:seg(?:ment)?|seg(?:ment)?number|seq(?:uence)?|sq|sn|chunk|frag(?:ment)?|part|number|start|offset|_HLS_msn|_HLS_part)$/i.test(key) && /^\d+$/.test(value)) { sequence = Number(value); break; }
    }
  }
  return { family: segmentFamilyKey(parsed.href), sequence, init, ext };
}

function segmentFamilyKey(url) {
  try {
    const parsed = new URL(String(url));
    let path = decodeURIComponent(parsed.pathname || '');
    path = path
      .replace(/((?:(?:file)?seq(?:uence)?|seg(?:ment)?|chunk|frag(?:ment)?|part)[-_.]?)\d{1,14}/ig, '$1{n}')
      .replace(/((?:(?:file)?seq(?:uence)?|seg(?:ment)?|chunk|frag(?:ment)?|part)[-_.]?)[a-z0-9_-]{3,80}(?=\.[a-z0-9]{1,8}$)/ig, '$1{id}')
      .replace(/(^|[/_.-])\d{1,14}(?=\.[a-z0-9]{1,8}$)/i, '$1{n}')
      .replace(/\/\d{1,14}(?=\/?$)/, '/{n}');
    if (!/[{](?:n|id)[}]/.test(path) && /\.(?:m4s|cmfv|cmfa|ismv|isma)$/i.test(path)) {
      path = path.replace(/[^/]+$/, `{fragment}.${path.split('.').pop()}`);
    }
    const kept = [];
    for (const [key, value] of parsed.searchParams.entries()) {
      if (/^(?:seg(?:ment)?|seg(?:ment)?number|seq(?:uence)?|sq|sn|chunk|frag(?:ment)?|part|number|start|offset|_HLS_msn|_HLS_part)$/i.test(key)) kept.push(`${key}={n}`);
      else if (/^(?:id|quality|rendition|track|stream|bitrate|audio|video)$/i.test(key) && value.length < 120) kept.push(`${key}=${value}`);
    }
    kept.sort();
    return `${parsed.origin}${path}${kept.length ? `?${kept.join('&')}` : ''}`;
  } catch (_) { return String(url || ''); }
}

function kindFromMime(mime) {
  if (!mime) return null;
  for (const [pattern, kind] of MIME_KIND) if (pattern.test(mime)) return kind;
  return null;
}

function kindFromUrl(url) {
  let path = '';
  try { path = new URL(url).pathname.toLowerCase(); } catch (_) { path = String(url).toLowerCase(); }
  const ext = path.split('.').pop().split(/[?#]/)[0];
  for (const [kind, list] of Object.entries(EXTENSIONS)) if (list.includes(ext)) return kind;
  if (/\.m3u8(?:$|[?#])/i.test(url)) return 'hls';
  if (/\.mpd(?:$|[?#])/i.test(url)) return 'dash';
  return null;
}

function filenameFromUrl(url, kind) {
  try {
    const parsed = new URL(url);
    const dispositionName = parsed.searchParams.get('filename') || parsed.searchParams.get('file');
    const raw = dispositionName || decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() || '');
    if (raw && raw.length < 180) return sanitizeFilename(raw);
  } catch (_) {}
  return `${kind || 'media'}-${new Date().toISOString().replace(/[:.]/g, '-')}${defaultExtension(kind)}`;
}

function defaultExtension(kind) {
  return ({ image: '.jpg', video: '.mp4', audio: '.mp3', hls: '.m3u8', dash: '.mpd', segment: '.mkv', blob: '.bin' })[kind] || '.bin';
}

function extensionFromUrl(url) {
  try {
    const match = new URL(url).pathname.match(/\.([a-z0-9]{1,8})$/i);
    return match ? `.${match[1].toLowerCase()}` : '';
  } catch (_) { return ''; }
}

function extensionFromMime(mime) {
  const map = {
    'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/avif': '.avif', 'image/gif': '.gif',
    'video/mp4': '.mp4', 'video/webm': '.webm', 'audio/mpeg': '.mp3', 'audio/mp4': '.m4a', 'audio/ogg': '.ogg'
  };
  return map[mime] || '';
}

function parseAttributeList(input) {
  const out = {};
  const re = /([A-Z0-9-]+)=((?:"[^"]*")|[^,]*)/gi;
  let match;
  while ((match = re.exec(input))) out[match[1].toUpperCase()] = match[2].replace(/^"|"$/g, '');
  return out;
}

function parseXmlAttributes(input) {
  const out = {};
  const re = /([\w:-]+)\s*=\s*"([^"]*)"/g;
  let match;
  while ((match = re.exec(input))) out[match[1]] = match[2];
  return out;
}

function resolveUrl(value, base) {
  try { return new URL(value, base).href; } catch (_) { return value; }
}


// Entries are normally consumed by onHeadersReceived/onErrorOccurred, but a
// request that ends any other way used to sit here forever holding cookie and
// authorization values. Bound the map the same way the per-tab store is bounded.
function rememberRequestHeaders(requestId, headers) {
  requestHeadersById.set(requestId, { headers, at: Date.now() });
  if (requestHeadersById.size <= 800) return;
  const cutoff = Date.now() - 5 * 60 * 1000;
  for (const [id, entry] of requestHeadersById) {
    if (entry.at < cutoff) requestHeadersById.delete(id);
  }
  if (requestHeadersById.size > 800) {
    const oldest = [...requestHeadersById.entries()].sort((a, b) => a[1].at - b[1].at);
    for (const [id] of oldest.slice(0, requestHeadersById.size - 600)) requestHeadersById.delete(id);
  }
}

function storeRequestHeaders(tabId, url, headers) {
  if (!requestHeaderStores.has(tabId)) requestHeaderStores.set(tabId, new Map());
  const store = requestHeaderStores.get(tabId);
  store.set(url, { headers, at: Date.now() });
  if (store.size > 600) {
    const entries = [...store.entries()].sort((a, b) => a[1].at - b[1].at);
    for (const [key] of entries.slice(0, store.size - 500)) store.delete(key);
  }
}

function getRequestHeaders(tabId, url) {
  const store = requestHeaderStores.get(tabId);
  if (!store) return {};
  const exact = store.get(url);
  if (exact && Date.now() - exact.at < 30 * 60 * 1000) return { ...exact.headers };
  try {
    const target = new URL(url);
    let best = null;
    for (const [candidateUrl, entry] of store) {
      if (Date.now() - entry.at > 30 * 60 * 1000) continue;
      const candidate = new URL(candidateUrl);
      if (candidate.origin === target.origin && candidate.pathname === target.pathname && (!best || entry.at > best.at)) best = entry;
    }
    return best ? { ...best.headers } : {};
  } catch (_) {
    return {};
  }
}

function headerMap(headers) {
  const out = {};
  for (const header of headers) {
    if (!header?.name) continue;
    out[header.name.toLowerCase()] = header.value || '';
  }
  return out;
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function sanitizeFilename(name) {
  return String(name || 'media')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/[. ]+$/g, '')
    .slice(0, 180) || 'media';
}

function sanitizePathPart(name) {
  return sanitizeFilename(name).replace(/\.+/g, '.');
}

function stripExtension(name) {
  return String(name).replace(/\.[a-z0-9]{1,8}$/i, '');
}

function hasExtension(name) {
  return /\.[a-z0-9]{1,8}$/i.test(name);
}

function stableUrlIdentity(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return String(value || '');
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch (_) {
    return String(value || '');
  }
}

function makeStableCacheKey(item = {}) {
  const url = stableUrlIdentity(item.url || '');
  const page = stableUrlIdentity(item.pageUrl || item.referrer || item.initiator || '');
  const title = stripExtension(item.filename || item.title || filenameFromUrl(item.url || '', item.kind || 'media'));
  const size = Number(item.size || item.blobSize || 0) || 0;
  return `ngcache_${hashString(`${item.kind || 'media'}|${page}|${url}|${title}|${size}`).slice(3)}`;
}

function hashString(input) {
  let h1 = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h1 ^= input.charCodeAt(i);
    h1 = Math.imul(h1, 0x01000193);
  }
  return `ng_${(h1 >>> 0).toString(36)}`;
}

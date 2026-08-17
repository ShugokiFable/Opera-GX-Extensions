'use strict';

const DEFAULT_SETTINGS = Object.freeze({
  captureMode: 'auto',
  format: 'png',
  quality: 0.94,
  upscale: '1x',
  destination: 'download',
  pauseDuringCapture: true,
  resumeAfterCapture: true,
  visibleCaptureDelay: 80,
  overlayEnabled: true,
  showToasts: true,
  microContrast: false,
  trimLetterbox: false,
  includeTimestampWatermark: false,
  downloadFolder: 'PrismShot GX/{site}/{date}',
  filenameTemplate: '{title} - {time} - {width}x{height}',
  conflictAction: 'uniquify',
  saveAs: false,
  historyLimit: 18,
  burstCount: 1,
  burstInterval: 650
});

const OFFSCREEN_URL = 'offscreen/offscreen.html';
let creatingOffscreen = null;
let captureQueue = Promise.resolve();

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  const { settings } = await chrome.storage.sync.get('settings');
  await chrome.storage.sync.set({ settings: { ...DEFAULT_SETTINGS, ...(settings || {}) } });

  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({
    id: 'prismshot-capture-video',
    title: 'Capture video frame with PrismShot GX',
    contexts: ['video']
  });
  chrome.contextMenus.create({
    id: 'prismshot-copy-video',
    title: 'Copy video frame with PrismShot GX',
    contexts: ['video']
  });

  if (reason === 'install') {
    await chrome.storage.local.set({ captureHistory: [] });
  }
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id) return;
  if (info.menuItemId === 'prismshot-capture-video') {
    enqueueCapture({ tabId: tab.id, destination: 'download', trigger: 'context-menu' }).catch(console.error);
  } else if (info.menuItemId === 'prismshot-copy-video') {
    enqueueCapture({ tabId: tab.id, destination: 'clipboard', trigger: 'context-menu' }).catch(console.error);
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;

  if (command === 'capture-frame') {
    enqueueCapture({ tabId: tab.id, trigger: 'shortcut' }).catch(console.error);
  } else if (command === 'copy-frame') {
    enqueueCapture({ tabId: tab.id, destination: 'clipboard', trigger: 'shortcut' }).catch(console.error);
  } else if (command === 'toggle-overlay') {
    const settings = await getSettings();
    settings.overlayEnabled = !settings.overlayEnabled;
    await chrome.storage.sync.set({ settings });
    await broadcastToFrames(tab.id, {
      type: 'PRISMSHOT_OVERLAY_SETTING',
      enabled: settings.overlayEnabled
    });
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') return undefined;

  if (message.type === 'PRISMSHOT_CAPTURE_REQUEST') {
    enqueueCapture({
      tabId: sender.tab?.id || message.tabId,
      frameId: sender.frameId ?? message.frameId,
      videoId: message.videoId,
      destination: message.destination,
      burstCount: message.burstCount,
      trigger: message.trigger || 'ui'
    }).then(sendResponse, (error) => sendResponse({ ok: false, error: humanizeError(error) }));
    return true;
  }

  if (message.type === 'PRISMSHOT_GET_STATUS') {
    getStatus(message.tabId).then(sendResponse, (error) => sendResponse({ ok: false, error: humanizeError(error) }));
    return true;
  }

  if (message.type === 'PRISMSHOT_STEP_REQUEST') {
    stepVideo({
      tabId: sender.tab?.id || message.tabId,
      frameId: sender.frameId ?? message.frameId,
      videoId: message.videoId,
      direction: message.direction || 1
    }).then(sendResponse, (error) => sendResponse({ ok: false, error: humanizeError(error) }));
    return true;
  }

  if (message.type === 'PRISMSHOT_OPEN_OPTIONS') {
    chrome.runtime.openOptionsPage();
    sendResponse({ ok: true });
    return undefined;
  }

  return undefined;
});

function enqueueCapture(request) {
  const task = captureQueue.then(() => runCaptureRequest(request));
  captureQueue = task.catch(() => undefined);
  return task;
}

async function runCaptureRequest(request) {
  const tabId = request.tabId || (await getActiveTab())?.id;
  if (!tabId) throw new Error('No active browser tab was found.');

  const settings = await getSettings();
  const destination = normalizeDestination(request.destination || settings.destination);
  const count = destination === 'clipboard' ? 1 : clampInt(request.burstCount ?? settings.burstCount, 1, 10);
  const results = [];

  for (let index = 0; index < count; index += 1) {
    results.push(await captureOne({
      ...request,
      tabId,
      settings,
      destination,
      burstIndex: index,
      burstTotal: count
    }));

    if (index < count - 1) {
      await sleep(Math.max(550, Number(settings.burstInterval) || 650));
    }
  }

  return { ok: true, count: results.length, results };
}

async function captureOne({ tabId, frameId, videoId, settings, destination, burstIndex, burstTotal }) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.active) {
    throw new Error('The video tab must be active to capture its visible frame.');
  }

  const discovery = await discoverVideos(tabId);
  const selected = chooseVideo(discovery.videos, frameId, videoId);
  if (!selected) {
    throw new Error('No visible, ready video was found on this page. Start playback or hover the video and try again.');
  }

  let sourceDataUrl = null;
  let crop = null;
  let engine = 'source';
  let nativeError = null;

  if (settings.captureMode !== 'visible') {
    const nativeResult = await sendToFrame(tabId, selected.frameId, {
      type: 'PRISMSHOT_CAPTURE_NATIVE',
      videoId: selected.videoId,
      pauseDuringCapture: Boolean(settings.pauseDuringCapture),
      resumeAfterCapture: Boolean(settings.resumeAfterCapture)
    }, 8000).catch((error) => ({ ok: false, error: humanizeError(error) }));

    if (nativeResult?.ok && nativeResult.dataUrl) {
      sourceDataUrl = nativeResult.dataUrl;
      selected.currentTime = nativeResult.currentTime ?? selected.currentTime;
      selected.videoWidth = nativeResult.width || selected.videoWidth;
      selected.videoHeight = nativeResult.height || selected.videoHeight;
    } else {
      nativeError = nativeResult?.error || 'The player blocked source-frame extraction.';
    }
  }

  if (!sourceDataUrl) {
    if (settings.captureMode === 'native') {
      throw new Error(`Clean source capture failed: ${nativeError || 'unknown player restriction'}`);
    }

    engine = 'visible';
    await broadcastToFrames(tabId, { type: 'PRISMSHOT_CAPTURE_VISIBILITY', hidden: true });
    let restoreToken = null;

    try {
      const prepare = await sendToFrame(tabId, selected.frameId, {
        type: 'PRISMSHOT_PREPARE_VISIBLE',
        videoId: selected.videoId,
        pauseDuringCapture: Boolean(settings.pauseDuringCapture)
      }, 3000).catch(() => null);
      restoreToken = prepare?.restoreToken || null;

      await sleep(clampInt(settings.visibleCaptureDelay, 0, 1000));
      sourceDataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
      crop = clampCrop(selected.topRect, discovery.topViewport);
      if (!crop || crop.width < 8 || crop.height < 8) {
        throw new Error('The selected video is outside the visible tab area.');
      }
    } finally {
      await sendToFrame(tabId, selected.frameId, {
        type: 'PRISMSHOT_RESTORE_VISIBLE',
        restoreToken,
        resumeAfterCapture: Boolean(settings.resumeAfterCapture)
      }, 1500).catch(() => undefined);
      await broadcastToFrames(tabId, { type: 'PRISMSHOT_CAPTURE_VISIBILITY', hidden: false });
    }
  }

  await ensureOffscreenDocument();

  const metadata = {
    title: tab.title || selected.frameTitle || 'Video frame',
    pageUrl: tab.url || selected.frameUrl || '',
    frameUrl: selected.frameUrl || '',
    site: safeHostname(tab.url || selected.frameUrl),
    currentTime: Number(selected.currentTime) || 0,
    duration: Number(selected.duration) || 0,
    sourceWidth: Number(selected.videoWidth) || 0,
    sourceHeight: Number(selected.videoHeight) || 0,
    capturedAt: new Date().toISOString(),
    engine,
    burstIndex,
    burstTotal
  };

  const processed = await chrome.runtime.sendMessage({
    type: 'PRISMSHOT_PROCESS_IMAGE',
    sourceDataUrl,
    crop,
    viewport: discovery.topViewport,
    settings: {
      format: settings.format,
      quality: settings.quality,
      upscale: settings.upscale,
      microContrast: settings.microContrast,
      trimLetterbox: settings.trimLetterbox,
      includeTimestampWatermark: settings.includeTimestampWatermark
    },
    metadata,
    destination
  });

  if (!processed?.ok) {
    throw new Error(processed?.error || 'Image processing failed.');
  }

  const filename = buildDownloadFilename(settings, metadata, processed, burstIndex, burstTotal);
  let downloadId = null;

  if (destination === 'download' || destination === 'both') {
    downloadId = await chrome.downloads.download({
      url: processed.objectUrl,
      filename,
      conflictAction: settings.conflictAction || 'uniquify',
      saveAs: Boolean(settings.saveAs)
    });
  }

  if ((destination === 'clipboard' || destination === 'both') && !processed.clipboardOk) {
    throw new Error(processed.clipboardError || 'The browser blocked clipboard image access.');
  }

  const record = {
    id: crypto.randomUUID(),
    filename,
    title: metadata.title,
    site: metadata.site,
    currentTime: metadata.currentTime,
    capturedAt: metadata.capturedAt,
    width: processed.width,
    height: processed.height,
    bytes: processed.bytes,
    format: processed.format,
    engine,
    thumbnail: processed.thumbnailDataUrl || null,
    destination,
    downloadId
  };
  await addHistory(record, settings.historyLimit);

  if (settings.showToasts) {
    const action = destination === 'clipboard' ? 'Copied' : destination === 'both' ? 'Saved + copied' : 'Saved';
    sendToFrame(tabId, selected.frameId, {
      type: 'PRISMSHOT_TOAST',
      message: `${action} ${processed.width}×${processed.height} ${processed.format.toUpperCase()}`,
      tone: 'success'
    }, 1000).catch(() => undefined);
  }

  return { ...record, ok: true };
}

async function getStatus(tabId) {
  const tab = tabId ? await chrome.tabs.get(tabId) : await getActiveTab();
  if (!tab?.id) throw new Error('No active tab.');

  const [settings, discovery, local] = await Promise.all([
    getSettings(),
    discoverVideos(tab.id),
    chrome.storage.local.get('captureHistory')
  ]);
  const selected = chooseVideo(discovery.videos);

  return {
    ok: true,
    tabId: tab.id,
    settings,
    videoCount: discovery.videos.length,
    selected: selected ? publicVideo(selected) : null,
    history: Array.isArray(local.captureHistory) ? local.captureHistory.slice(0, 12) : []
  };
}

async function stepVideo({ tabId, frameId, videoId, direction }) {
  if (!tabId) throw new Error('No active tab.');
  let targetFrame = frameId;
  let targetVideo = videoId;

  if (targetFrame == null || !targetVideo) {
    const discovery = await discoverVideos(tabId);
    const selected = chooseVideo(discovery.videos, targetFrame, targetVideo);
    if (!selected) throw new Error('No video found.');
    targetFrame = selected.frameId;
    targetVideo = selected.videoId;
  }

  const result = await sendToFrame(tabId, targetFrame, {
    type: 'PRISMSHOT_STEP_VIDEO',
    videoId: targetVideo,
    direction: direction < 0 ? -1 : 1
  }, 3000);

  if (!result?.ok) throw new Error(result?.error || 'Unable to step this video.');
  return result;
}

async function discoverVideos(tabId) {
  let frames = await chrome.webNavigation.getAllFrames({ tabId }).catch(() => null);
  let frameList = Array.isArray(frames) && frames.length ? frames : [{ frameId: 0 }];
  let responses = await probeFrameList(tabId, frameList);

  if (!responses.some(Boolean)) {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ['src/content.js']
    }).catch(() => undefined);
    await sleep(80);
    frames = await chrome.webNavigation.getAllFrames({ tabId }).catch(() => null);
    frameList = Array.isArray(frames) && frames.length ? frames : [{ frameId: 0 }];
    responses = await probeFrameList(tabId, frameList);
  }

  const videos = [];
  let topViewport = null;

  for (const response of responses) {
    if (!response) continue;
    if (response.frameId === 0 && response.viewport) topViewport = response.viewport;
    for (const video of response.videos || []) {
      videos.push({
        ...video,
        frameId: response.frameId,
        frameTitle: response.frameTitle,
        frameUrl: response.frameUrl
      });
    }
  }

  if (!topViewport) {
    const topResponse = responses.find(Boolean);
    topViewport = topResponse?.topViewport || topResponse?.viewport || { width: 1, height: 1, devicePixelRatio: 1 };
  }

  videos.sort((a, b) => scoreVideo(b) - scoreVideo(a));
  return { videos, topViewport };
}


async function probeFrameList(tabId, frameList) {
  return Promise.all(frameList.map(async (frame) => {
    const response = await sendToFrame(tabId, frame.frameId, { type: 'PRISMSHOT_PROBE' }, 1800).catch(() => null);
    return response ? { frameId: frame.frameId, ...response } : null;
  }));
}

function chooseVideo(videos, frameId, videoId) {
  if (frameId != null && videoId) {
    const exact = videos.find((video) => video.frameId === frameId && video.videoId === videoId);
    if (exact) return exact;
  }
  if (videoId) {
    const byId = videos.find((video) => video.videoId === videoId);
    if (byId) return byId;
  }
  return videos.find((video) => video.visible && video.readyState >= 2) || videos[0] || null;
}

function scoreVideo(video) {
  const area = Math.max(0, Number(video.visibleArea) || Number(video.area) || 0);
  const playing = video.paused ? 0 : 1_000_000_000;
  const ready = (Number(video.readyState) || 0) * 10_000_000;
  const recent = Math.max(0, 30_000 - (Date.now() - (Number(video.lastInteraction) || 0)));
  const visible = video.visible ? 100_000_000 : 0;
  return playing + visible + ready + area + recent;
}

function publicVideo(video) {
  return {
    frameId: video.frameId,
    videoId: video.videoId,
    width: video.videoWidth,
    height: video.videoHeight,
    renderedWidth: Math.round(video.topRect?.width || 0),
    renderedHeight: Math.round(video.topRect?.height || 0),
    currentTime: video.currentTime,
    duration: video.duration,
    paused: video.paused,
    muted: video.muted,
    hasCaptions: video.hasCaptions,
    sourceHost: video.sourceHost,
    frameTitle: video.frameTitle,
    engineHint: video.canvasLikelySafe ? 'source' : 'auto'
  };
}

async function broadcastToFrames(tabId, message) {
  const frames = await chrome.webNavigation.getAllFrames({ tabId }).catch(() => null);
  const frameList = Array.isArray(frames) && frames.length ? frames : [{ frameId: 0 }];
  await Promise.allSettled(frameList.map((frame) => sendToFrame(tabId, frame.frameId, message, 1000)));
}

async function sendToFrame(tabId, frameId, message, timeoutMs = 2000) {
  const messagePromise = chrome.tabs.sendMessage(tabId, message, { frameId });
  return promiseWithTimeout(messagePromise, timeoutMs, 'The page did not respond in time.');
}

async function getSettings() {
  const { settings } = await chrome.storage.sync.get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

async function ensureOffscreenDocument() {
  const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_URL);
  let exists = false;

  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [offscreenUrl]
    });
    exists = contexts.length > 0;
  } else {
    const clientsList = await clients.matchAll();
    exists = clientsList.some((client) => client.url === offscreenUrl);
  }

  if (exists) return;
  if (creatingOffscreen) return creatingOffscreen;

  creatingOffscreen = chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['BLOBS', 'CLIPBOARD'],
    justification: 'Crop and encode captured video frames and copy image data to the clipboard.'
  }).finally(() => {
    creatingOffscreen = null;
  });

  return creatingOffscreen;
}

async function addHistory(record, limit) {
  const { captureHistory } = await chrome.storage.local.get('captureHistory');
  const history = Array.isArray(captureHistory) ? captureHistory : [];
  history.unshift(record);
  const max = clampInt(limit, 0, 50);
  await chrome.storage.local.set({ captureHistory: max ? history.slice(0, max) : [] });
}

function buildDownloadFilename(settings, metadata, processed, burstIndex, burstTotal) {
  const date = new Date(metadata.capturedAt);
  const replacements = {
    title: sanitizeSegment(metadata.title || 'Video frame', 110),
    site: sanitizeSegment(metadata.site || 'site', 50),
    date: localDate(date),
    timestamp: localTimestamp(date),
    time: mediaTime(metadata.currentTime),
    width: String(processed.width),
    height: String(processed.height),
    resolution: `${processed.width}x${processed.height}`,
    engine: metadata.engine,
    index: String((burstIndex || 0) + 1).padStart(2, '0')
  };

  let folder = renderTemplate(settings.downloadFolder || 'PrismShot GX', replacements);
  let base = renderTemplate(settings.filenameTemplate || '{title} - {time}', replacements);
  if (burstTotal > 1 && !(settings.filenameTemplate || '').includes('{index}')) {
    base += ` - ${replacements.index}`;
  }

  folder = folder.split('/').map((part) => sanitizeSegment(part, 60)).filter(Boolean).join('/');
  base = sanitizeSegment(base, 160) || 'Video frame';
  const extension = processed.format === 'jpeg' ? 'jpg' : processed.format;
  return `${folder ? `${folder}/` : ''}${base}.${extension}`;
}

function renderTemplate(template, values) {
  return String(template).replace(/\{([a-z]+)\}/gi, (match, key) => values[key] ?? match);
}

function sanitizeSegment(value, maxLength = 100) {
  const clean = String(value)
    .replace(/[<>:"\\|?*\u0000-\u001F]/g, ' ')
    .replace(/[. ]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
  return clean === '.' || clean === '..' ? '_' : clean;
}

function localDate(date) {
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
}

function localTimestamp(date) {
  return `${localDate(date)}_${String(date.getHours()).padStart(2, '0')}-${String(date.getMinutes()).padStart(2, '0')}-${String(date.getSeconds()).padStart(2, '0')}`;
}

function mediaTime(seconds) {
  const safe = Math.max(0, Number(seconds) || 0);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = Math.floor(safe % 60);
  const millis = Math.floor((safe % 1) * 1000);
  return `${String(hours).padStart(2, '0')}-${String(minutes).padStart(2, '0')}-${String(secs).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

function safeHostname(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '') || 'site';
  } catch {
    return 'site';
  }
}

function clampCrop(rect, viewport) {
  if (!rect || !viewport) return null;
  const left = Math.max(0, Number(rect.left) || 0);
  const top = Math.max(0, Number(rect.top) || 0);
  const right = Math.min(Number(viewport.width) || 0, (Number(rect.left) || 0) + (Number(rect.width) || 0));
  const bottom = Math.min(Number(viewport.height) || 0, (Number(rect.top) || 0) + (Number(rect.height) || 0));
  return {
    left,
    top,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top)
  };
}

function normalizeDestination(value) {
  return ['download', 'clipboard', 'both'].includes(value) ? value : 'download';
}

function clampInt(value, min, max) {
  const number = Math.round(Number(value));
  return Math.min(max, Math.max(min, Number.isFinite(number) ? number : min));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function promiseWithTimeout(promise, timeoutMs, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(message)), timeoutMs))
  ]);
}

function humanizeError(error) {
  const message = error?.message || String(error || 'Unknown error');
  if (message.includes('Receiving end does not exist')) {
    return 'PrismShot cannot run on this browser page. Open a normal website tab containing a video.';
  }
  if (message.includes('Cannot access')) {
    return 'The browser blocked extension access to this page.';
  }
  return message;
}

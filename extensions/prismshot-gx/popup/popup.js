'use strict';

const state = {
  tabId: null,
  settings: null,
  selected: null,
  busy: false
};

const elements = {};

document.addEventListener('DOMContentLoaded', init);

async function init() {
  for (const id of [
    'statusCard', 'statusTitle', 'statusMeta', 'engineBadge', 'captureButton', 'captureHint',
    'copyButton', 'stepBack', 'stepForward', 'captureMode', 'format', 'upscale',
    'burstCount', 'quality', 'qualityValue', 'qualityRow', 'history', 'clearHistory',
    'openOptions', 'footerState'
  ]) elements[id] = document.getElementById(id);

  elements.captureButton.addEventListener('click', () => capture(state.settings?.destination || 'download'));
  elements.copyButton.addEventListener('click', () => capture('clipboard'));
  elements.stepBack.addEventListener('click', () => step(-1));
  elements.stepForward.addEventListener('click', () => step(1));
  elements.openOptions.addEventListener('click', () => chrome.runtime.openOptionsPage());
  elements.clearHistory.addEventListener('click', clearHistory);

  for (const key of ['captureMode', 'format', 'upscale', 'burstCount']) {
    elements[key].addEventListener('change', saveQuickSettings);
  }
  elements.quality.addEventListener('input', () => {
    elements.qualityValue.textContent = `${elements.quality.value}%`;
  });
  elements.quality.addEventListener('change', saveQuickSettings);

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  state.tabId = tab?.id || null;
  await refresh();
}

async function refresh() {
  setFooter('SCANNING');
  const response = await chrome.runtime.sendMessage({
    type: 'PRISMSHOT_GET_STATUS',
    tabId: state.tabId
  }).catch((error) => ({ ok: false, error: error.message }));

  if (!response?.ok) {
    showError(response?.error || 'Unable to inspect this tab.');
    return;
  }

  state.settings = response.settings;
  state.selected = response.selected;
  hydrateControls(response.settings);
  renderStatus(response);
  renderHistory(response.history || []);
  setFooter('READY');
}

function hydrateControls(settings) {
  elements.captureMode.value = settings.captureMode;
  elements.format.value = settings.format;
  elements.upscale.value = settings.upscale;
  elements.burstCount.value = String(settings.burstCount);
  elements.quality.value = String(Math.round((settings.quality || 0.94) * 100));
  elements.qualityValue.textContent = `${elements.quality.value}%`;
  updateHints();
}

function renderStatus(response) {
  const video = response.selected;
  elements.statusCard.classList.toggle('ready', Boolean(video));
  elements.statusCard.classList.toggle('error', !video);

  if (!video) {
    elements.statusTitle.textContent = 'No active video detected';
    elements.statusMeta.textContent = 'Start playback, then reopen PrismShot GX';
    elements.engineBadge.textContent = 'IDLE';
    setDisabled(true);
    return;
  }

  const resolution = video.width && video.height ? `${video.width}×${video.height}` : `${video.renderedWidth}×${video.renderedHeight}`;
  const playback = video.paused ? 'paused' : 'playing';
  const captions = video.hasCaptions ? ' · captions' : '';
  elements.statusTitle.textContent = video.frameTitle || video.sourceHost || 'Active video';
  elements.statusMeta.textContent = `${resolution} · ${formatClock(video.currentTime)} · ${playback}${captions}`;
  elements.engineBadge.textContent = state.settings.captureMode === 'native' ? 'SOURCE' : state.settings.captureMode === 'visible' ? 'VISIBLE' : 'AUTO';
  setDisabled(false);
}

function renderHistory(history) {
  if (!history.length) {
    elements.history.innerHTML = '<div class="empty-history">No frames captured yet.</div>';
    return;
  }

  elements.history.replaceChildren(...history.slice(0, 8).map((item) => {
    const row = document.createElement('div');
    row.className = 'history-item';

    const image = document.createElement('img');
    image.alt = '';
    image.src = item.thumbnail || '';

    const copy = document.createElement('div');
    copy.className = 'history-copy';
    const title = document.createElement('b');
    title.textContent = item.title || item.filename || 'Video frame';
    const meta = document.createElement('small');
    meta.textContent = `${item.width}×${item.height} · ${formatBytes(item.bytes)} · ${formatClock(item.currentTime)}`;
    copy.append(title, meta);

    const engine = document.createElement('span');
    engine.className = 'history-engine';
    engine.textContent = item.engine || 'source';

    row.append(image, copy, engine);
    return row;
  }));
}

async function capture(destination) {
  if (state.busy || !state.selected) return;
  setBusy(true, destination === 'clipboard' ? 'COPYING' : 'CAPTURING');

  const response = await chrome.runtime.sendMessage({
    type: 'PRISMSHOT_CAPTURE_REQUEST',
    tabId: state.tabId,
    frameId: state.selected.frameId,
    videoId: state.selected.videoId,
    destination,
    burstCount: Number(elements.burstCount.value),
    trigger: 'popup'
  }).catch((error) => ({ ok: false, error: error.message }));

  if (!response?.ok) {
    showError(response?.error || 'Capture failed.');
    setBusy(false);
    return;
  }

  setFooter(destination === 'clipboard' ? 'COPIED' : response.count > 1 ? `${response.count} SAVED` : 'SAVED');
  setBusy(false);
  await refresh();
}

async function step(direction) {
  if (state.busy || !state.selected) return;
  const response = await chrome.runtime.sendMessage({
    type: 'PRISMSHOT_STEP_REQUEST',
    tabId: state.tabId,
    frameId: state.selected.frameId,
    videoId: state.selected.videoId,
    direction
  }).catch((error) => ({ ok: false, error: error.message }));

  if (!response?.ok) {
    showError(response?.error || 'Frame stepping failed.');
    return;
  }
  state.selected.currentTime = response.currentTime;
  elements.statusMeta.textContent = elements.statusMeta.textContent.replace(/\d+:\d{2}(?::\d{2})?/, formatClock(response.currentTime));
}

async function saveQuickSettings() {
  if (!state.settings) return;
  state.settings = {
    ...state.settings,
    captureMode: elements.captureMode.value,
    format: elements.format.value,
    upscale: elements.upscale.value,
    burstCount: Number(elements.burstCount.value),
    quality: Number(elements.quality.value) / 100
  };
  await chrome.storage.sync.set({ settings: state.settings });
  updateHints();
  renderStatus({ selected: state.selected });
}

function updateHints() {
  const format = elements.format.value.toUpperCase().replace('JPEG', 'JPG');
  const destination = state.settings?.destination === 'clipboard' ? 'Clipboard' : state.settings?.destination === 'both' ? 'Downloads + Clipboard' : 'Downloads';
  const burst = Number(elements.burstCount.value);
  elements.captureHint.textContent = `${format}${burst > 1 && state.settings?.destination !== 'clipboard' ? ` · ${burst}-frame burst` : ''} to ${destination}`;
  elements.qualityRow.classList.toggle('hidden', elements.format.value === 'png');
}

async function clearHistory() {
  await chrome.storage.local.set({ captureHistory: [] });
  renderHistory([]);
}

function setBusy(busy, label = 'WORKING') {
  state.busy = busy;
  elements.captureButton.disabled = busy || !state.selected;
  elements.copyButton.disabled = busy || !state.selected;
  elements.stepBack.disabled = busy || !state.selected;
  elements.stepForward.disabled = busy || !state.selected;
  if (busy) setFooter(label);
}

function setDisabled(disabled) {
  elements.captureButton.disabled = disabled;
  elements.copyButton.disabled = disabled;
  elements.stepBack.disabled = disabled;
  elements.stepForward.disabled = disabled;
}

function setFooter(text, error = false) {
  elements.footerState.textContent = text;
  elements.footerState.classList.toggle('error', error);
}

function showError(message) {
  elements.statusCard.classList.remove('ready');
  elements.statusCard.classList.add('error');
  elements.statusTitle.textContent = 'Capture unavailable';
  elements.statusMeta.textContent = message;
  elements.engineBadge.textContent = 'ERROR';
  setFooter('ERROR', true);
}

function formatClock(seconds) {
  const safe = Math.max(0, Number(seconds) || 0);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = Math.floor(safe % 60);
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
    : `${minutes}:${String(secs).padStart(2, '0')}`;
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(0)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

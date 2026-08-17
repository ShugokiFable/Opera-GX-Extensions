'use strict';

const DEFAULTS = {
  captureMode: 'auto', format: 'png', quality: 0.94, upscale: '1x', destination: 'download',
  pauseDuringCapture: true, resumeAfterCapture: true, visibleCaptureDelay: 80,
  overlayEnabled: true, showToasts: true, microContrast: false, trimLetterbox: false,
  includeTimestampWatermark: false, downloadFolder: 'PrismShot GX/{site}/{date}',
  filenameTemplate: '{title} - {time} - {width}x{height}', conflictAction: 'uniquify',
  saveAs: false, historyLimit: 18, burstCount: 1, burstInterval: 650
};

const ids = [
  'format', 'destination', 'upscale', 'burstCount', 'quality', 'pauseDuringCapture',
  'resumeAfterCapture', 'visibleCaptureDelay', 'burstInterval', 'microContrast',
  'trimLetterbox', 'includeTimestampWatermark', 'saveAs', 'downloadFolder',
  'filenameTemplate', 'overlayEnabled', 'showToasts', 'historyLimit', 'qualityValue',
  'filenamePreview', 'saveState', 'saveButton', 'resetButton', 'clearHistory'
];
const elements = Object.fromEntries(ids.map((id) => [id, document.getElementById(id)]));
let settings = { ...DEFAULTS };
let saveTimer = null;

document.addEventListener('DOMContentLoaded', load);
elements.saveButton.addEventListener('click', save);
elements.resetButton.addEventListener('click', reset);
elements.clearHistory.addEventListener('click', clearHistory);
document.addEventListener('input', handleInput);
document.addEventListener('change', handleInput);

async function load() {
  const stored = await chrome.storage.sync.get('settings');
  settings = { ...DEFAULTS, ...(stored.settings || {}) };
  hydrate(settings);
  setState('Settings loaded');
}

function hydrate(value) {
  const mode = document.querySelector(`input[name="captureMode"][value="${value.captureMode}"]`);
  if (mode) mode.checked = true;

  for (const key of ['format', 'destination', 'upscale', 'burstCount', 'visibleCaptureDelay', 'burstInterval', 'downloadFolder', 'filenameTemplate', 'historyLimit']) {
    elements[key].value = String(value[key]);
  }
  for (const key of ['pauseDuringCapture', 'resumeAfterCapture', 'microContrast', 'trimLetterbox', 'includeTimestampWatermark', 'saveAs', 'overlayEnabled', 'showToasts']) {
    elements[key].checked = Boolean(value[key]);
  }
  elements.quality.value = String(Math.round(value.quality * 100));
  updatePreview();
}

function collect() {
  return {
    ...settings,
    captureMode: document.querySelector('input[name="captureMode"]:checked')?.value || 'auto',
    format: elements.format.value,
    destination: elements.destination.value,
    upscale: elements.upscale.value,
    burstCount: Number(elements.burstCount.value),
    quality: Number(elements.quality.value) / 100,
    pauseDuringCapture: elements.pauseDuringCapture.checked,
    resumeAfterCapture: elements.resumeAfterCapture.checked,
    visibleCaptureDelay: clampInt(elements.visibleCaptureDelay.value, 0, 1000),
    burstInterval: clampInt(elements.burstInterval.value, 550, 5000),
    microContrast: elements.microContrast.checked,
    trimLetterbox: elements.trimLetterbox.checked,
    includeTimestampWatermark: elements.includeTimestampWatermark.checked,
    saveAs: elements.saveAs.checked,
    downloadFolder: elements.downloadFolder.value.trim(),
    filenameTemplate: elements.filenameTemplate.value.trim(),
    overlayEnabled: elements.overlayEnabled.checked,
    showToasts: elements.showToasts.checked,
    historyLimit: clampInt(elements.historyLimit.value, 0, 50)
  };
}

function handleInput() {
  settings = collect();
  updatePreview();
  setState('Unsaved changes');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 700);
}

async function save() {
  clearTimeout(saveTimer);
  settings = collect();
  await chrome.storage.sync.set({ settings });
  setState('Saved');
}

async function reset() {
  settings = { ...DEFAULTS };
  hydrate(settings);
  await chrome.storage.sync.set({ settings });
  setState('Defaults restored');
}

async function clearHistory() {
  await chrome.storage.local.set({ captureHistory: [] });
  setState('Capture history cleared');
}

function updatePreview() {
  elements.qualityValue.textContent = `${elements.quality.value}%`;
  const values = {
    title: 'Example Video', site: 'example.com', date: '2026-07-18', timestamp: '2026-07-18_21-45-12',
    time: '00-14-32.188', width: '3840', height: '2160', resolution: '3840x2160', engine: 'source', index: '01'
  };
  const folder = render(elements.downloadFolder.value || 'PrismShot GX', values);
  const base = render(elements.filenameTemplate.value || '{title} - {time}', values);
  const extension = elements.format.value === 'jpeg' ? 'jpg' : elements.format.value;
  elements.filenamePreview.textContent = `${folder}/${base}.${extension}`;
}

function render(template, values) {
  return String(template).replace(/\{([a-z]+)\}/gi, (match, key) => values[key] ?? match);
}

function setState(message) {
  elements.saveState.textContent = message;
}

function clampInt(value, min, max) {
  const number = Math.round(Number(value));
  return Math.min(max, Math.max(min, Number.isFinite(number) ? number : min));
}

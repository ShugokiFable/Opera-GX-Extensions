'use strict';

const DEFAULTS = {
  enabled: true,
  convertLightPages: true,
  strength: 88,
  blackCutoff: 18,
  targetContrast: 7,
  pureBlack: true,
  preserveBrandColors: true,
  mediaMode: 'untouched',
  sharpenText: false,
  panelGuard: false,
  idleDimMinutes: 0,
  idleShade: 14,
  staticUiOpacity: 78,
  performance: 'balanced',
  excludedSites: []
};

let tab;
let host = '';
let settings = { ...DEFAULTS };
let sites = {};
let status = null;

const $ = (id) => document.getElementById(id);

function hostname(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

async function send(message) {
  if (!tab?.id) return null;
  try { return await chrome.tabs.sendMessage(tab.id, message); } catch { return null; }
}

async function persistSettings(patch) {
  settings = { ...settings, ...patch };
  await chrome.storage.sync.set({ oledForgeSettings: settings });
}

async function persistSite(enabled) {
  sites[host] = { ...(sites[host] || {}), enabled };
  await chrome.storage.sync.set({ oledForgeSites: sites });
}

function render() {
  $('host').textContent = host || 'Protected browser page';
  $('enabled').checked = Boolean(settings.enabled);
  $('siteEnabled').checked = host ? (sites[host]?.enabled ?? true) : false;
  $('siteEnabled').disabled = !host;
  $('strength').value = settings.strength;
  $('strengthOut').value = `${settings.strength}%`;
  $('blackCutoff').value = settings.blackCutoff;
  $('cutoffOut').value = `${settings.blackCutoff}%`;
  $('convertLightPages').checked = Boolean(settings.convertLightPages);
  $('pureBlack').checked = Boolean(settings.pureBlack);
  $('panelGuard').checked = Boolean(settings.panelGuard);

  const active = Boolean(status?.active);
  const kind = status?.pageKind || (host ? 'loading' : 'restricted');
  $('pageKind').textContent = active ? kind.toUpperCase() : 'OFF';
  $('pageKind').classList.toggle('live', active);
  $('siteState').textContent = host ? (active ? 'Engine active here' : 'Engine paused here') : 'Browser pages cannot be modified';
  $('surfaces').textContent = status?.stats?.backgrounds ?? 0;
  $('text').textContent = status?.stats?.foregrounds ?? 0;
  $('queue').textContent = status?.stats?.queue ?? 0;
}

async function refreshStatus() {
  status = await send({ type: 'OLED_FORGE_STATUS' });
  render();
}

function bind() {
  $('enabled').addEventListener('change', async (event) => {
    await persistSettings({ enabled: event.target.checked });
    setTimeout(refreshStatus, 80);
  });
  $('siteEnabled').addEventListener('change', async (event) => {
    await persistSite(event.target.checked);
    setTimeout(refreshStatus, 80);
  });
  $('strength').addEventListener('input', (event) => $('strengthOut').value = `${event.target.value}%`);
  $('strength').addEventListener('change', async (event) => persistSettings({ strength: Number(event.target.value) }));
  $('blackCutoff').addEventListener('input', (event) => $('cutoffOut').value = `${event.target.value}%`);
  $('blackCutoff').addEventListener('change', async (event) => persistSettings({ blackCutoff: Number(event.target.value) }));
  for (const id of ['convertLightPages', 'pureBlack', 'panelGuard']) {
    $(id).addEventListener('change', async (event) => persistSettings({ [id]: event.target.checked }));
  }
  $('rescan').addEventListener('click', async () => {
    status = await send({ type: 'OLED_FORGE_RESCAN' });
    render();
  });
  $('options').addEventListener('click', () => chrome.runtime.openOptionsPage());

  document.querySelectorAll('[data-preset]').forEach((button) => {
    button.addEventListener('click', async () => {
      const preset = button.dataset.preset;
      const patches = {
        native: { strength: 100, blackCutoff: 24, targetContrast: 7, pureBlack: true, mediaMode: 'untouched', sharpenText: false },
        balanced: { strength: 82, blackCutoff: 16, targetContrast: 7, pureBlack: true, mediaMode: 'untouched', sharpenText: false },
        cinema: { strength: 92, blackCutoff: 22, targetContrast: 5.5, pureBlack: true, mediaMode: 'deep', sharpenText: false },
        reading: { strength: 72, blackCutoff: 14, targetContrast: 8, pureBlack: false, mediaMode: 'untouched', sharpenText: true }
      };
      await persistSettings(patches[preset]);
      status = await send({ type: 'OLED_FORGE_RELOAD' });
      render();
    });
  });
}

(async () => {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  host = hostname(tab?.url || '');
  const data = await chrome.storage.sync.get(['oledForgeSettings', 'oledForgeSites']);
  settings = { ...DEFAULTS, ...(data.oledForgeSettings || {}) };
  sites = data.oledForgeSites || {};
  bind();
  await refreshStatus();
  setTimeout(refreshStatus, 350);
})();

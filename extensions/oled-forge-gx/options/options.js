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

const ids = Object.keys(DEFAULTS);
const $ = (id) => document.getElementById(id);
let settings = { ...DEFAULTS };

function setValue(id, value) {
  const element = $(id);
  if (!element) return;
  if (element.type === 'checkbox') element.checked = Boolean(value);
  else if (id === 'excludedSites') element.value = (value || []).join('\n');
  else element.value = value;
}

function render() {
  ids.forEach((id) => setValue(id, settings[id]));
  $('strengthOut').value = `${settings.strength}%`;
  $('blackCutoffOut').value = `${settings.blackCutoff}%`;
  $('targetContrastOut').value = `${settings.targetContrast}:1`;
}

function read() {
  const next = { ...settings };
  for (const id of ids) {
    const element = $(id);
    if (!element) continue;
    if (element.type === 'checkbox') next[id] = element.checked;
    else if (id === 'excludedSites') next[id] = element.value.split(/\r?\n/).map((line) => line.trim().toLowerCase()).filter(Boolean);
    else if (element.type === 'number' || element.type === 'range') next[id] = Number(element.value);
    else next[id] = element.value;
  }
  return next;
}

async function save() {
  settings = read();
  await chrome.storage.sync.set({ oledForgeSettings: settings });
  $('saved').textContent = 'Saved';
  setTimeout(() => $('saved').textContent = 'Saved locally', 1000);
}

(async () => {
  const data = await chrome.storage.sync.get('oledForgeSettings');
  settings = { ...DEFAULTS, ...(data.oledForgeSettings || {}) };
  render();

  $('strength').addEventListener('input', (e) => $('strengthOut').value = `${e.target.value}%`);
  $('blackCutoff').addEventListener('input', (e) => $('blackCutoffOut').value = `${e.target.value}%`);
  $('targetContrast').addEventListener('input', (e) => $('targetContrastOut').value = `${e.target.value}:1`);
  $('save').addEventListener('click', save);
  $('reset').addEventListener('click', async () => {
    settings = { ...DEFAULTS };
    render();
    await save();
  });
})();

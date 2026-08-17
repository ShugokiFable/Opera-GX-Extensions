'use strict';

const ui = Object.fromEntries([...document.querySelectorAll('[id]')].map((el) => [el.id, el]));
let activeTab = null;
let host = '';
let globalSettings = { ...Nocturne.DEFAULT_SETTINGS };
let rules = {};
let scope = 'global';
let toastTimer = 0;

function toast(message) {
  ui.toast.textContent = message;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { ui.toast.textContent = ''; }, 1800);
}

function currentRule() {
  return host ? Nocturne.sanitizeRule(rules[host]) : Nocturne.sanitizeRule(null);
}

function editedSettings() {
  if (scope === 'global' || !host) return globalSettings;
  return Nocturne.sanitizeSettings({ ...globalSettings, ...currentRule().settings });
}

async function reloadState() {
  const state = await Nocturne.readState();
  globalSettings = state.global;
  rules = state.rules;
  render();
}

function renderPresets(settings) {
  ui.presetGrid.replaceChildren();
  for (const [id, preset] of Object.entries(Nocturne.PRESETS)) {
    const button = document.createElement('button');
    button.className = `preset${settings.preset === id ? ' active' : ''}`;
    button.dataset.preset = id;
    button.title = preset.description;
    button.innerHTML = `<span class="swatch" style="background:linear-gradient(90deg,${preset.thumb},${preset.thumb2})"></span><b>${preset.label}</b>`;
    ui.presetGrid.appendChild(button);
  }
}

function render() {
  const supported = Boolean(host);
  const ruleMatch = supported ? Nocturne.matchRule(host, rules) : null;
  const siteEnabled = ruleMatch ? Nocturne.sanitizeRule(ruleMatch.rule).enabled : true;
  const settings = editedSettings();

  ui.domainLabel.textContent = supported ? host.replace('__local_files__', 'Local files') : 'Restricted browser page';
  ui.restrictedNotice.classList.toggle('hidden', supported);
  ui.globalEnabled.checked = globalSettings.enabled;
  ui.siteEnabled.checked = siteEnabled;
  ui.siteEnabled.disabled = !supported || !globalSettings.enabled;
  ui.siteStateText.textContent = !supported ? 'Unavailable here' : ruleMatch ? (siteEnabled ? `Profile: ${ruleMatch.pattern}` : 'Disabled by site rule') : 'Uses global settings';
  ui.resetSite.disabled = !supported || !ruleMatch;
  ui.scopeLabel.textContent = scope.toUpperCase();

  document.querySelectorAll('[data-scope]').forEach((button) => {
    button.classList.toggle('active', button.dataset.scope === scope);
    if (button.dataset.scope === 'site') button.disabled = !supported;
  });

  ui.width.value = settings.width;
  ui.widthOut.value = `${settings.width} px`;
  ui.glow.value = settings.glow;
  ui.glowOut.value = `${settings.glow} px`;
  ui.visibility.value = settings.visibility;
  renderPresets(settings);
}

async function writePatch(patch) {
  if (scope === 'site' && host) {
    const previous = currentRule();
    rules = await Nocturne.setSiteRule(host, { enabled: previous.enabled, settings: { ...previous.settings, ...patch } });
  } else {
    globalSettings = await Nocturne.writeGlobal({ ...globalSettings, ...patch });
  }
  render();
}

ui.globalEnabled.addEventListener('change', async () => {
  globalSettings = await Nocturne.writeGlobal({ ...globalSettings, enabled: ui.globalEnabled.checked });
  render();
  toast(globalSettings.enabled ? 'Nocturne online' : 'Nocturne globally disabled');
});

ui.siteEnabled.addEventListener('change', async () => {
  if (!host) return;
  rules = await Nocturne.setSiteRule(host, { enabled: ui.siteEnabled.checked });
  render();
  toast(ui.siteEnabled.checked ? 'Enabled on this site' : 'Disabled on this site');
});

document.querySelector('.scope-tabs').addEventListener('click', (event) => {
  const button = event.target.closest('[data-scope]');
  if (!button || button.disabled) return;
  scope = button.dataset.scope;
  render();
});

ui.presetGrid.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-preset]');
  if (!button) return;
  const id = button.dataset.preset;
  if (scope === 'site' && host) {
    const preset = Nocturne.PRESETS[id];
    rules = await Nocturne.setSiteRule(host, { settings: { ...preset, preset: id } });
  } else {
    globalSettings = await Nocturne.writeGlobal(Nocturne.applyPreset(globalSettings, id));
  }
  render();
  toast(`${Nocturne.PRESETS[id].label} applied`);
});

ui.width.addEventListener('input', () => { ui.widthOut.value = `${ui.width.value} px`; });
ui.width.addEventListener('change', () => writePatch({ width: Number(ui.width.value), height: Number(ui.width.value) }));
ui.glow.addEventListener('input', () => { ui.glowOut.value = `${ui.glow.value} px`; });
ui.glow.addEventListener('change', () => writePatch({ glow: Number(ui.glow.value) }));
ui.visibility.addEventListener('change', () => writePatch({ visibility: ui.visibility.value }));

ui.resetSite.addEventListener('click', async () => {
  if (!host) return;
  rules = await Nocturne.removeSiteRule(host);
  scope = 'global';
  render();
  toast('Site profile cleared');
});

ui.openStudio.addEventListener('click', () => chrome.runtime.openOptionsPage());

(async () => {
  [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  host = Nocturne.domainFromUrl(activeTab?.url || '');
  await reloadState();
})().catch((error) => {
  ui.domainLabel.textContent = 'Could not read this tab';
  toast(error.message);
});

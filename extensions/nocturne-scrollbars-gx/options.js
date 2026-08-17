'use strict';

const ui = Object.fromEntries([...document.querySelectorAll('[id]')].map((el) => [el.id, el]));
const numericKeys = ['width', 'height', 'radius', 'minThumb', 'borderWidth', 'trackAlpha', 'glow', 'glowAlpha', 'ambientBlend', 'minContrast'];
const colorKeys = ['track', 'thumb', 'thumb2', 'hover', 'active', 'border'];
const booleanKeys = ['enabled', 'gradient', 'adaptiveTrack', 'contrastGuard', 'motion', 'respectReducedMotion', 'touchBoost', 'deepShadowDom'];
const formatters = {
  width: (v) => `${v} px`, height: (v) => `${v} px`, radius: (v) => `${v} px`, minThumb: (v) => `${v} px`, borderWidth: (v) => `${v} px`,
  trackAlpha: (v) => `${Math.round(v * 100)}%`, glow: (v) => `${v} px`, glowAlpha: (v) => `${Math.round(v * 100)}%`,
  ambientBlend: (v) => `${Math.round(v * 100)}%`, minContrast: (v) => `${Number(v).toFixed(1)}:1`
};

let settings = { ...Nocturne.DEFAULT_SETTINGS };
let rules = {};
let saveTimer = 0;
let toastTimer = 0;

function toast(message) {
  ui.toast.textContent = message;
  ui.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ui.toast.classList.remove('show'), 1800);
}

function setSaveState(text, good = false) {
  ui.saveState.textContent = text;
  ui.saveState.style.color = good ? '#52cd7c' : '#a68cff';
}

function scheduleSave() {
  clearTimeout(saveTimer);
  setSaveState('Saving…');
  saveTimer = setTimeout(async () => {
    try {
      settings = await Nocturne.writeGlobal(settings);
      setSaveState('Saved', true);
      await updateDiagnostics();
    } catch (error) {
      // A swallowed rejection used to leave the page stuck on "Saving…" forever.
      setSaveState('Not saved');
      toast(error?.message || 'Storage rejected the write');
    }
  }, 250);
}

function renderPresetCards() {
  ui.presetCards.replaceChildren();
  for (const [id, preset] of Object.entries(Nocturne.PRESETS)) {
    const button = document.createElement('button');
    button.className = `preset-card${settings.preset === id ? ' active' : ''}`;
    button.dataset.preset = id;
    button.title = preset.description;
    button.innerHTML = `<span class="beam" style="display:block;background:linear-gradient(90deg,${preset.track},${preset.thumb},${preset.thumb2})"></span><b>${preset.label}</b><small>${preset.description}</small>`;
    ui.presetCards.appendChild(button);
  }
  ui.activePreset.textContent = Nocturne.PRESETS[settings.preset]?.label || 'Custom Signal';
}

function updateOutputs() {
  for (const key of numericKeys) {
    const output = ui[`${key}Out`];
    if (output) output.value = formatters[key](settings[key]);
  }
  for (const key of colorKeys) ui[`${key}Code`].textContent = settings[key].toUpperCase();
  ui.engineStatus.textContent = settings.enabled ? 'Online' : 'Offline';
  ui.engineStatus.style.color = settings.enabled ? '#5ddd87' : '#f08aa2';
}

function previewCss(s) {
  const ambient = '#090b10';
  let track = s.adaptiveTrack ? Nocturne.mixHex(s.track, ambient, s.ambientBlend) : s.track;
  let thumb = s.thumb;
  let thumb2 = s.thumb2;
  let hover = s.hover;
  let active = s.active;
  if (s.contrastGuard) {
    thumb = Nocturne.ensureContrast(thumb, track, s.minContrast);
    thumb2 = Nocturne.ensureContrast(thumb2, track, s.minContrast);
    hover = Nocturne.ensureContrast(hover, track, Math.max(2.6, s.minContrast));
    active = Nocturne.ensureContrast(active, track, Math.max(3, s.minContrast));
  }
  const idle = s.visibility === 'hover' ? 0.08 : s.visibility === 'minimal' ? 0.52 : 1;
  const trackAlpha = s.visibility === 'always' ? s.trackAlpha : 0;
  const base = s.gradient
    ? `linear-gradient(180deg,${Nocturne.rgba(thumb,idle)},${Nocturne.rgba(thumb2,idle)})`
    : Nocturne.rgba(thumb,idle);
  return `
.preview-scroll { scrollbar-color:${Nocturne.rgba(thumb,idle)} ${Nocturne.rgba(track,trackAlpha)}; scrollbar-width:${s.width <= 10 ? 'thin' : 'auto'}; }
.preview-scroll::-webkit-scrollbar { width:${s.width}px; height:${s.height}px; background:${Nocturne.rgba(track,trackAlpha)}; }
.preview-scroll::-webkit-scrollbar-track { background:${Nocturne.rgba(track,trackAlpha)}; border-radius:${s.radius}px; }
.preview-scroll::-webkit-scrollbar-thumb { min-height:${s.minThumb}px; background:${base}; background-clip:padding-box; border:${s.borderWidth}px solid ${Nocturne.rgba(s.border,.98)}; border-radius:${s.radius}px; box-shadow:inset 0 0 0 1px ${Nocturne.rgba('#ffffff',.06)},0 0 ${s.glow}px ${Nocturne.rgba(thumb2,s.glowAlpha*idle)}; transition:${s.motion ? `background ${s.motionMs}ms ease,box-shadow ${s.motionMs}ms ease` : 'none'}; }
.preview-scroll::-webkit-scrollbar-thumb:hover { background:linear-gradient(180deg,${hover},${Nocturne.mixHex(hover,active,.25)}); box-shadow:0 0 ${Math.max(s.glow,8)+4}px ${Nocturne.rgba(hover,Math.min(.9,s.glowAlpha+.16))}; }
.preview-scroll::-webkit-scrollbar-thumb:active { background:${active}; }
.preview-scroll::-webkit-scrollbar-corner { background:${Nocturne.rgba(track,trackAlpha)}; }
`;
}

function updatePreview() {
  let style = document.getElementById('nocturne-preview-style');
  if (!style) {
    style = document.createElement('style');
    style.id = 'nocturne-preview-style';
    document.head.appendChild(style);
  }
  style.textContent = previewCss(settings);
}

function renderSettings() {
  for (const key of numericKeys) ui[key].value = settings[key];
  for (const key of colorKeys) ui[key].value = settings[key];
  for (const key of booleanKeys) ui[key].checked = settings[key];
  ui.visibility.value = settings.visibility;
  ui.motionMs.value = String(settings.motionMs);
  updateOutputs();
  renderPresetCards();
  updatePreview();
}

function renderRules() {
  ui.siteRules.replaceChildren();
  const entries = Object.entries(rules).sort(([a], [b]) => a.localeCompare(b));
  ui.ruleCount.textContent = String(entries.length);
  if (!entries.length) {
    const empty = document.createElement('div');
    empty.className = 'site-empty';
    empty.textContent = 'No site profiles yet. Use the popup on a website or add a domain above.';
    ui.siteRules.appendChild(empty);
    return;
  }
  for (const [pattern, rawRule] of entries) {
    const rule = Nocturne.sanitizeRule(rawRule);
    const row = document.createElement('div');
    row.className = 'site-rule';
    row.dataset.pattern = pattern;
    const overrideCount = Object.keys(rule.settings).length;
    row.innerHTML = `<div><b>${pattern}</b><small>${overrideCount ? `${overrideCount} visual overrides` : 'Uses global appearance'}</small></div>
      <label class="switch"><input data-action="toggle" type="checkbox" ${rule.enabled ? 'checked' : ''}><span></span></label>
      <button data-action="delete" type="button">Remove</button>`;
    ui.siteRules.appendChild(row);
  }
}

async function updateDiagnostics() {
  const [syncBytes, localBytes] = await Promise.all([
    chrome.storage.sync.getBytesInUse(null).catch(() => 0),
    chrome.storage.local.getBytesInUse(null).catch(() => 0)
  ]);
  ui.syncBytes.textContent = `${syncBytes} B`;
  ui.localBytes.textContent = `${localBytes} B`;
  ui.ruleCount.textContent = String(Object.keys(rules).length);
}

for (const key of numericKeys) {
  ui[key].addEventListener('input', () => {
    settings = Nocturne.sanitizeSettings({ ...settings, [key]: Number(ui[key].value) });
    updateOutputs();
    updatePreview();
    settings.preset = 'custom';
    renderPresetCards();
    scheduleSave();
  });
}

for (const key of colorKeys) {
  ui[key].addEventListener('input', () => {
    settings = Nocturne.sanitizeSettings({ ...settings, [key]: ui[key].value, preset: 'custom' });
    updateOutputs();
    updatePreview();
    renderPresetCards();
    scheduleSave();
  });
}

for (const key of booleanKeys) {
  ui[key].addEventListener('change', () => {
    settings = Nocturne.sanitizeSettings({ ...settings, [key]: ui[key].checked });
    updateOutputs();
    updatePreview();
    scheduleSave();
  });
}

ui.visibility.addEventListener('change', () => {
  settings = Nocturne.sanitizeSettings({ ...settings, visibility: ui.visibility.value, preset: 'custom' });
  updatePreview(); renderPresetCards(); scheduleSave();
});
ui.motionMs.addEventListener('change', () => {
  settings = Nocturne.sanitizeSettings({ ...settings, motionMs: Number(ui.motionMs.value), preset: 'custom' });
  updatePreview(); renderPresetCards(); scheduleSave();
});

ui.presetCards.addEventListener('click', (event) => {
  const button = event.target.closest('[data-preset]');
  if (!button) return;
  settings = Nocturne.applyPreset(settings, button.dataset.preset);
  renderSettings();
  scheduleSave();
  toast(`${Nocturne.PRESETS[button.dataset.preset].label} loaded`);
});

ui.randomize.addEventListener('click', () => {
  const ids = Object.keys(Nocturne.PRESETS);
  const id = ids[Math.floor(Math.random() * ids.length)];
  settings = Nocturne.applyPreset(settings, id);
  settings.glow = Nocturne.clamp(settings.glow + Math.floor(Math.random() * 7) - 3, 0, 30);
  renderSettings();
  scheduleSave();
});

ui.addSiteForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const pattern = Nocturne.normalizePattern(ui.sitePattern.value);
  if (!pattern) return toast('Enter a valid domain or wildcard');
  rules[pattern] = Nocturne.sanitizeRule(rules[pattern]);
  rules = await Nocturne.writeRules(rules);
  ui.sitePattern.value = '';
  renderRules();
  updateDiagnostics();
  toast('Site profile added');
});

ui.siteRules.addEventListener('change', async (event) => {
  const input = event.target.closest('[data-action="toggle"]');
  if (!input) return;
  const pattern = input.closest('.site-rule').dataset.pattern;
  rules[pattern] = { ...Nocturne.sanitizeRule(rules[pattern]), enabled: input.checked };
  rules = await Nocturne.writeRules(rules);
  renderRules();
  toast(input.checked ? 'Profile enabled' : 'Profile disabled');
});

ui.siteRules.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-action="delete"]');
  if (!button) return;
  const pattern = button.closest('.site-rule').dataset.pattern;
  delete rules[pattern];
  rules = await Nocturne.writeRules(rules);
  renderRules();
  updateDiagnostics();
  toast('Profile removed');
});

ui.exportConfig.addEventListener('click', () => {
  const payload = JSON.stringify({
    format: 'nocturne-scrollbars-gx',
    version: 1,
    exportedAt: new Date().toISOString(),
    global: settings,
    siteRules: rules
  }, null, 2);
  const url = URL.createObjectURL(new Blob([payload], { type: 'application/json' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `nocturne-scrollbars-gx-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('Configuration exported');
});

ui.importConfig.addEventListener('change', async () => {
  const [file] = ui.importConfig.files;
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    if (parsed.format !== 'nocturne-scrollbars-gx') throw new Error('Not a Nocturne configuration');
    settings = Nocturne.sanitizeSettings(parsed.global);
    rules = Nocturne.sanitizeRules(parsed.siteRules);
    await Promise.all([Nocturne.writeGlobal(settings), Nocturne.writeRules(rules)]);
    renderSettings(); renderRules(); updateDiagnostics();
    toast('Configuration imported');
  } catch (error) {
    toast(error.message || 'Import failed');
  } finally {
    ui.importConfig.value = '';
  }
});

ui.pushSync.addEventListener('click', async () => {
  try {
    const result = await Nocturne.pushToSync();
    toast(`Sent to sync: ${result.rules} profile(s), ${result.bytes} B`);
    updateDiagnostics();
  } catch (error) {
    toast(error?.message || 'Sync storage rejected the write (8 KB per item limit)');
  }
});

ui.pullSync.addEventListener('click', async () => {
  try {
    const state = await Nocturne.pullFromSync();
    settings = state.global;
    rules = state.rules;
    renderSettings(); renderRules(); updateDiagnostics();
    toast('Profile loaded from sync');
  } catch (error) {
    toast(error?.message || 'Could not load from sync');
  }
});

ui.resetAll.addEventListener('click', async () => {
  settings = { ...Nocturne.DEFAULT_SETTINGS };
  rules = {};
  await Promise.all([Nocturne.writeGlobal(settings), Nocturne.writeRules(rules)]);
  renderSettings(); renderRules(); updateDiagnostics();
  toast('Factory defaults restored');
});

const observer = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    document.querySelectorAll('.sidebar nav a').forEach((link) => link.classList.toggle('active', link.getAttribute('href') === `#${entry.target.id}`));
  }
}, { rootMargin: '-20% 0px -70% 0px' });
document.querySelectorAll('section[id]').forEach((section) => observer.observe(section));

(async () => {
  const state = await Nocturne.readState();
  settings = state.global;
  rules = state.rules;
  renderSettings();
  renderRules();
  await updateDiagnostics();
})().catch((error) => toast(error.message));

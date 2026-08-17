(() => {
  'use strict';

  const STORAGE_KEYS = Object.freeze({
    GLOBAL: 'nocturneGlobal',
    RULES: 'nocturneSiteRules'
  });

  const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    preset: 'gx-reactor',
    width: 12,
    height: 12,
    hoverWidth: 14,
    radius: 10,
    minThumb: 34,
    track: '#08090f',
    trackAlpha: 0.96,
    thumb: '#7257ff',
    thumb2: '#cf3dff',
    hover: '#f04fd8',
    active: '#20ddff',
    border: '#11131c',
    borderWidth: 2,
    glow: 14,
    glowAlpha: 0.42,
    gradient: true,
    visibility: 'always',
    motion: true,
    motionMs: 150,
    adaptiveTrack: true,
    ambientBlend: 0.06,
    contrastGuard: true,
    minContrast: 2.3,
    deepShadowDom: false,
    respectReducedMotion: true,
    touchBoost: true
  });

  const PRESETS = Object.freeze({
    'gx-reactor': {
      label: 'GX Reactor',
      description: 'Purple-magenta energy with a cyan active state.',
      track: '#08090f', thumb: '#7257ff', thumb2: '#cf3dff', hover: '#f04fd8', active: '#20ddff', border: '#11131c',
      glow: 14, glowAlpha: 0.42, gradient: true, width: 12, radius: 10, visibility: 'always'
    },
    'oled-void': {
      label: 'OLED Void',
      description: 'Near-black, low-distraction, and crisp.',
      track: '#020204', thumb: '#353542', thumb2: '#5a5a6d', hover: '#87879c', active: '#c5c5d2', border: '#020204',
      glow: 4, glowAlpha: 0.18, gradient: true, width: 11, radius: 9, visibility: 'minimal'
    },
    'graphite-pro': {
      label: 'Graphite Pro',
      description: 'Neutral dark metal for workspaces and dashboards.',
      track: '#0c0e12', thumb: '#4e5563', thumb2: '#747d8e', hover: '#9aa4b6', active: '#d6dbe5', border: '#151820',
      glow: 6, glowAlpha: 0.18, gradient: true, width: 12, radius: 8, visibility: 'always'
    },
    'crimson-core': {
      label: 'Crimson Core',
      description: 'Red-hot GX styling without turning the page into a carnival.',
      track: '#0a0508', thumb: '#9f1f48', thumb2: '#f04462', hover: '#ff5c7a', active: '#ffb347', border: '#190912',
      glow: 16, glowAlpha: 0.46, gradient: true, width: 12, radius: 10, visibility: 'always'
    },
    'arctic-circuit': {
      label: 'Arctic Circuit',
      description: 'Cold cyan-blue with clean technical contrast.',
      track: '#050a0e', thumb: '#087ea4', thumb2: '#21d4e5', hover: '#5cecff', active: '#d0fbff', border: '#07141a',
      glow: 15, glowAlpha: 0.42, gradient: true, width: 12, radius: 10, visibility: 'always'
    },
    'phosphor-terminal': {
      label: 'Phosphor Terminal',
      description: 'Green phosphor signal on a black shell.',
      track: '#020703', thumb: '#167b3a', thumb2: '#39d96d', hover: '#75f29a', active: '#d2ffdf', border: '#061108',
      glow: 13, glowAlpha: 0.38, gradient: true, width: 11, radius: 7, visibility: 'minimal'
    }
  });

  const NUMERIC_LIMITS = Object.freeze({
    width: [6, 24],
    height: [6, 24],
    hoverWidth: [6, 28],
    radius: [0, 20],
    minThumb: [16, 100],
    trackAlpha: [0, 1],
    borderWidth: [0, 5],
    glow: [0, 30],
    glowAlpha: [0, 1],
    motionMs: [0, 600],
    ambientBlend: [0, 0.35],
    minContrast: [1, 7]
  });

  const COLOR_KEYS = new Set(['track', 'thumb', 'thumb2', 'hover', 'active', 'border']);
  const BOOLEAN_KEYS = new Set([
    'enabled', 'gradient', 'motion', 'adaptiveTrack', 'contrastGuard', 'deepShadowDom', 'respectReducedMotion', 'touchBoost'
  ]);
  const STRING_ENUMS = Object.freeze({
    visibility: new Set(['always', 'minimal', 'hover'])
  });

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  function normalizeHex(value, fallback = '#000000') {
    if (typeof value !== 'string') return fallback;
    const raw = value.trim();
    const short = /^#([0-9a-f]{3})$/i.exec(raw);
    if (short) {
      return `#${short[1].split('').map((c) => c + c).join('').toLowerCase()}`;
    }
    const full = /^#([0-9a-f]{6})$/i.exec(raw);
    return full ? `#${full[1].toLowerCase()}` : fallback;
  }

  function hexToRgb(hex) {
    const clean = normalizeHex(hex).slice(1);
    return {
      r: parseInt(clean.slice(0, 2), 16),
      g: parseInt(clean.slice(2, 4), 16),
      b: parseInt(clean.slice(4, 6), 16)
    };
  }

  function rgbToHex({ r, g, b }) {
    const part = (n) => clamp(Math.round(n), 0, 255).toString(16).padStart(2, '0');
    return `#${part(r)}${part(g)}${part(b)}`;
  }

  function rgba(hex, alpha = 1) {
    const { r, g, b } = hexToRgb(hex);
    return `rgba(${r}, ${g}, ${b}, ${clamp(Number(alpha) || 0, 0, 1).toFixed(3)})`;
  }

  function mixHex(a, b, amount = 0.5) {
    const A = hexToRgb(a);
    const B = hexToRgb(b);
    const t = clamp(Number(amount) || 0, 0, 1);
    return rgbToHex({
      r: A.r + (B.r - A.r) * t,
      g: A.g + (B.g - A.g) * t,
      b: A.b + (B.b - A.b) * t
    });
  }

  function relativeLuminance(hex) {
    const { r, g, b } = hexToRgb(hex);
    const channel = (v) => {
      const n = v / 255;
      return n <= 0.04045 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  }

  function contrastRatio(a, b) {
    const l1 = relativeLuminance(a);
    const l2 = relativeLuminance(b);
    const high = Math.max(l1, l2);
    const low = Math.min(l1, l2);
    return (high + 0.05) / (low + 0.05);
  }

  function ensureContrast(foreground, background, minimum) {
    const fg = normalizeHex(foreground);
    const bg = normalizeHex(background);
    if (contrastRatio(fg, bg) >= minimum) return fg;
    const toward = relativeLuminance(bg) < 0.45 ? '#ffffff' : '#000000';
    for (let step = 0.05; step <= 1; step += 0.05) {
      const candidate = mixHex(fg, toward, step);
      if (contrastRatio(candidate, bg) >= minimum) return candidate;
    }
    return toward;
  }

  function sanitizeSettings(input = {}, { partial = false } = {}) {
    const base = partial ? {} : { ...DEFAULT_SETTINGS };
    if (!input || typeof input !== 'object' || Array.isArray(input)) return base;

    for (const [key, value] of Object.entries(input)) {
      if (!(key in DEFAULT_SETTINGS)) continue;
      if (COLOR_KEYS.has(key)) {
        base[key] = normalizeHex(value, DEFAULT_SETTINGS[key]);
      } else if (BOOLEAN_KEYS.has(key)) {
        base[key] = Boolean(value);
      } else if (NUMERIC_LIMITS[key]) {
        const [min, max] = NUMERIC_LIMITS[key];
        const numeric = Number(value);
        if (Number.isFinite(numeric)) base[key] = clamp(numeric, min, max);
      } else if (STRING_ENUMS[key]) {
        if (STRING_ENUMS[key].has(value)) base[key] = value;
      } else if (key === 'preset') {
        base[key] = typeof value === 'string' ? value.slice(0, 64) : DEFAULT_SETTINGS.preset;
      }
    }
    return base;
  }

  function applyPreset(settings, presetId) {
    const preset = PRESETS[presetId];
    if (!preset) return sanitizeSettings(settings);
    return sanitizeSettings({ ...settings, ...preset, preset: presetId });
  }

  function domainFromUrl(url) {
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:', 'file:'].includes(parsed.protocol)) return '';
      if (parsed.protocol === 'file:') return '__local_files__';
      return parsed.hostname.toLowerCase();
    } catch {
      return '';
    }
  }

  function normalizePattern(pattern) {
    if (typeof pattern !== 'string') return '';
    let value = pattern.trim().toLowerCase();
    if (!value) return '';
    if (value === '__local_files__') return value;

    const wildcard = value.startsWith('*.');
    value = value.replace(/^https?:\/\//, '').split('/')[0].replace(/:\d+$/, '');
    if (wildcard) value = value.slice(2);
    value = value.replace(/^\.+|\.+$/g, '');
    if (!value || !/^[a-z0-9.-]+$/.test(value) || value.includes('..')) return '';

    try {
      const hostname = new URL(`http://${value}`).hostname.toLowerCase();
      if (!hostname || !/^[a-z0-9.-]+$/.test(hostname)) return '';
      return wildcard ? `*.${hostname}` : hostname;
    } catch {
      return '';
    }
  }

  function matchRule(host, rules = {}) {
    if (!host || !rules || typeof rules !== 'object') return null;
    if (rules[host]) return { pattern: host, rule: rules[host] };
    let best = null;
    for (const [pattern, rule] of Object.entries(rules)) {
      if (!pattern.startsWith('*.')) continue;
      const suffix = pattern.slice(2);
      if (host === suffix || host.endsWith(`.${suffix}`)) {
        if (!best || suffix.length > best.pattern.length - 2) best = { pattern, rule };
      }
    }
    return best;
  }

  function sanitizeRule(rule) {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) return { enabled: true, settings: {} };
    return {
      enabled: rule.enabled !== false,
      settings: sanitizeSettings(rule.settings || {}, { partial: true })
    };
  }

  function sanitizeRules(rules) {
    const clean = {};
    if (!rules || typeof rules !== 'object' || Array.isArray(rules)) return clean;
    for (const [rawPattern, rawRule] of Object.entries(rules)) {
      const pattern = normalizePattern(rawPattern);
      if (!pattern) continue;
      clean[pattern] = sanitizeRule(rawRule);
    }
    return clean;
  }

  function effectiveSettings(globalSettings, rules, host) {
    const global = sanitizeSettings(globalSettings);
    const match = matchRule(host, sanitizeRules(rules));
    if (!match) return { settings: global, pattern: '', siteEnabled: true };
    const rule = sanitizeRule(match.rule);
    return {
      settings: sanitizeSettings({ ...global, ...rule.settings, enabled: global.enabled && rule.enabled }),
      pattern: match.pattern,
      siteEnabled: rule.enabled
    };
  }

  function parseCssColor(value, fallback = '#ffffff') {
    if (typeof value !== 'string') return fallback;
    const hex = value.trim();
    if (/^#[0-9a-f]{3,6}$/i.test(hex)) return normalizeHex(hex, fallback);
    const match = /rgba?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)/i.exec(hex);
    if (!match) return fallback;
    return rgbToHex({ r: Number(match[1]), g: Number(match[2]), b: Number(match[3]) });
  }

  function buildScrollbarCss(rawSettings, ambientHex = '#ffffff', { shadow = false } = {}) {
    const settings = sanitizeSettings(rawSettings);
    const ambient = normalizeHex(ambientHex, '#ffffff');
    let track = settings.track;
    if (settings.adaptiveTrack) track = mixHex(track, ambient, settings.ambientBlend);

    let thumb = settings.thumb;
    let thumb2 = settings.thumb2;
    let hover = settings.hover;
    let active = settings.active;
    if (settings.contrastGuard) {
      thumb = ensureContrast(thumb, track, settings.minContrast);
      thumb2 = ensureContrast(thumb2, track, settings.minContrast);
      hover = ensureContrast(hover, track, Math.max(settings.minContrast, 2.6));
      active = ensureContrast(active, track, Math.max(settings.minContrast, 3));
    }

    const baseAlpha = settings.visibility === 'hover' ? 0.08 : settings.visibility === 'minimal' ? 0.52 : 1;
    const trackAlpha = settings.visibility === 'minimal' || settings.visibility === 'hover' ? 0 : settings.trackAlpha;
    const thumbBaseA = rgba(thumb, baseAlpha);
    const thumb2BaseA = rgba(thumb2, baseAlpha);
    const trackColor = rgba(track, trackAlpha);
    const borderColor = rgba(settings.border, Math.min(1, settings.trackAlpha + 0.03));
    const transition = settings.motion ? `background ${settings.motionMs}ms ease, box-shadow ${settings.motionMs}ms ease, border-color ${settings.motionMs}ms ease` : 'none';
    const selectorRoot = shadow ? ':host' : ':root';
    const selectorAny = '*';
    const selector = `${selectorRoot}, ${selectorAny}`;
    const webkit = `${selectorRoot}::-webkit-scrollbar, ${selectorAny}::-webkit-scrollbar`;
    const webkitTrack = `${selectorRoot}::-webkit-scrollbar-track, ${selectorAny}::-webkit-scrollbar-track`;
    const webkitTrackPiece = `${selectorRoot}::-webkit-scrollbar-track-piece, ${selectorAny}::-webkit-scrollbar-track-piece`;
    const webkitThumb = `${selectorRoot}::-webkit-scrollbar-thumb, ${selectorAny}::-webkit-scrollbar-thumb`;
    const webkitThumbHover = `${selectorRoot}::-webkit-scrollbar-thumb:hover, ${selectorAny}::-webkit-scrollbar-thumb:hover`;
    const webkitThumbActive = `${selectorRoot}::-webkit-scrollbar-thumb:active, ${selectorAny}::-webkit-scrollbar-thumb:active`;
    const webkitCorner = `${selectorRoot}::-webkit-scrollbar-corner, ${selectorAny}::-webkit-scrollbar-corner`;
    const webkitButton = `${selectorRoot}::-webkit-scrollbar-button, ${selectorAny}::-webkit-scrollbar-button`;
    const background = settings.gradient
      ? `linear-gradient(180deg, ${thumbBaseA} 0%, ${thumb2BaseA} 100%)`
      : thumbBaseA;
    const hoverBackground = settings.gradient
      ? `linear-gradient(180deg, ${rgba(hover, 1)} 0%, ${rgba(mixHex(hover, active, 0.25), 1)} 100%)`
      : rgba(hover, 1);

    return `
${selector} {
  scrollbar-color: ${rgba(thumb, baseAlpha)} ${trackColor} !important;
  scrollbar-width: ${settings.width <= 10 ? 'thin' : 'auto'} !important;
}
${webkit} {
  width: ${settings.width}px !important;
  height: ${settings.height}px !important;
  background: ${trackColor} !important;
}
${webkitTrack}, ${webkitTrackPiece} {
  background: ${trackColor} !important;
  border-radius: ${settings.radius}px !important;
}
${webkitThumb} {
  min-height: ${settings.minThumb}px !important;
  min-width: ${settings.minThumb}px !important;
  background: ${background} !important;
  background-clip: padding-box !important;
  border: ${settings.borderWidth}px solid ${borderColor} !important;
  border-radius: ${settings.radius}px !important;
  box-shadow: inset 0 0 0 1px ${rgba('#ffffff', settings.visibility === 'always' ? 0.055 : 0.02)}, 0 0 ${settings.glow}px ${rgba(thumb2, settings.glowAlpha * baseAlpha)} !important;
  transition: ${transition} !important;
}
${webkitThumbHover} {
  background: ${hoverBackground} !important;
  border-color: ${rgba(settings.border, 0.96)} !important;
  box-shadow: inset 0 0 0 1px ${rgba('#ffffff', 0.12)}, 0 0 ${Math.max(settings.glow, 8) + 4}px ${rgba(hover, Math.min(0.9, settings.glowAlpha + 0.16))} !important;
}
${webkitThumbActive} {
  background: ${rgba(active, 1)} !important;
  box-shadow: inset 0 0 0 1px ${rgba('#ffffff', 0.18)}, 0 0 ${Math.max(settings.glow, 8) + 6}px ${rgba(active, Math.min(0.95, settings.glowAlpha + 0.22))} !important;
}
${webkitCorner} {
  background: ${trackColor} !important;
}
${webkitButton} {
  display: none !important;
  width: 0 !important;
  height: 0 !important;
}
${settings.touchBoost ? `@media (pointer: coarse) {
  ${webkit} { width: ${Math.max(settings.width, 14)}px !important; height: ${Math.max(settings.height, 14)}px !important; }
}` : ''}
${settings.respectReducedMotion ? `@media (prefers-reduced-motion: reduce) {
  ${webkitThumb} { transition: none !important; }
}` : ''}
@media (forced-colors: active) {
  ${selector} { scrollbar-color: auto !important; }
  ${webkitThumb}, ${webkitTrack}, ${webkitTrackPiece} { forced-color-adjust: auto !important; }
}
`.trim();
  }

  // Appearance used to live in chrome.storage.sync, which caps writes at 120 per
  // minute and 1800 per hour. Dragging sliders in the Studio burned through that
  // and edits started failing silently. Local is authoritative now; sync is
  // opt-in, on a button, for moving a profile between machines.
  async function readState() {
    const [local, sync] = await Promise.all([
      chrome.storage.local.get([STORAGE_KEYS.GLOBAL, STORAGE_KEYS.RULES]),
      chrome.storage.sync.get(STORAGE_KEYS.GLOBAL).catch(() => ({}))
    ]);
    const migrated = local[STORAGE_KEYS.GLOBAL] || sync[STORAGE_KEYS.GLOBAL];
    return {
      global: sanitizeSettings(migrated),
      rules: sanitizeRules(local[STORAGE_KEYS.RULES])
    };
  }

  async function writeGlobal(settings) {
    const clean = sanitizeSettings(settings);
    await chrome.storage.local.set({ [STORAGE_KEYS.GLOBAL]: clean });
    return clean;
  }

  async function pushToSync() {
    const { global, rules } = await readState();
    // Sync caps a single item at 8 KB; a large site-rule set will not fit and
    // that has to be said out loud rather than silently dropping profiles.
    const payload = { [STORAGE_KEYS.GLOBAL]: global, [STORAGE_KEYS.RULES]: rules };
    const bytes = new TextEncoder().encode(JSON.stringify(payload)).length;
    await chrome.storage.sync.set(payload);
    return { bytes, rules: Object.keys(rules).length };
  }

  async function pullFromSync() {
    const sync = await chrome.storage.sync.get([STORAGE_KEYS.GLOBAL, STORAGE_KEYS.RULES]);
    if (!sync[STORAGE_KEYS.GLOBAL]) throw new Error('Nothing has been synced from another machine yet');
    const global = sanitizeSettings(sync[STORAGE_KEYS.GLOBAL]);
    const rules = sanitizeRules(sync[STORAGE_KEYS.RULES]);
    await chrome.storage.local.set({ [STORAGE_KEYS.GLOBAL]: global, [STORAGE_KEYS.RULES]: rules });
    return { global, rules };
  }

  async function writeRules(rules) {
    const clean = sanitizeRules(rules);
    await chrome.storage.local.set({ [STORAGE_KEYS.RULES]: clean });
    return clean;
  }

  async function setSiteRule(pattern, patch = {}) {
    const normalized = normalizePattern(pattern);
    if (!normalized) throw new Error('Invalid site pattern');
    const { rules } = await readState();
    const previous = sanitizeRule(rules[normalized]);
    rules[normalized] = sanitizeRule({
      enabled: patch.enabled === undefined ? previous.enabled : patch.enabled,
      settings: patch.settings === undefined ? previous.settings : { ...previous.settings, ...patch.settings }
    });
    return writeRules(rules);
  }

  async function removeSiteRule(pattern) {
    const normalized = normalizePattern(pattern);
    const { rules } = await readState();
    delete rules[normalized];
    return writeRules(rules);
  }

  globalThis.Nocturne = Object.freeze({
    STORAGE_KEYS,
    DEFAULT_SETTINGS,
    PRESETS,
    clamp,
    normalizeHex,
    hexToRgb,
    rgbToHex,
    rgba,
    mixHex,
    relativeLuminance,
    contrastRatio,
    ensureContrast,
    sanitizeSettings,
    sanitizeRule,
    sanitizeRules,
    applyPreset,
    domainFromUrl,
    normalizePattern,
    matchRule,
    effectiveSettings,
    parseCssColor,
    buildScrollbarCss,
    readState,
    writeGlobal,
    writeRules,
    pushToSync,
    pullFromSync,
    setSiteRule,
    removeSiteRule
  });
})();

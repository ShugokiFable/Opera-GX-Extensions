(() => {
  'use strict';

  if (globalThis.__OLED_FORGE_ENGINE__) return;
  globalThis.__OLED_FORGE_ENGINE__ = true;

  const C = globalThis.OLEDColor;
  const D = globalThis.OLEDDetection;
  if (!C || !D) return;

  const DEFAULTS = Object.freeze({
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
  });

  const GENERIC_PROFILE = Object.freeze({
    name: 'generic',
    mergeContrast: 1.5,
    mergeMaxLuminance: 0.19,
    proseMinLightness: 0.79,
    proseSelector: '',
    cleanNeutralGradients: true,
    inspectPseudoSurfaces: true
  });

  const SITE_PROFILES = Object.freeze([
    {
      test: (name) => name === 'youtube.com' || name.endsWith('.youtube.com'),
      profile: {
        ...GENERIC_PROFILE,
        name: 'youtube',
        mergeContrast: 1.7,
        proseMinLightness: 0.84,
        proseSelector: [
          '#description-inline-expander',
          'ytd-text-inline-expander#description-inline-expander',
          'ytd-watch-metadata #description',
          '#description ytd-text-inline-expander',
          'yt-attributed-string#description-text'
        ].join(',')
      }
    },
    {
      test: (name) => name === 'nexusmods.com' || name.endsWith('.nexusmods.com'),
      profile: {
        ...GENERIC_PROFILE,
        name: 'nexusmods',
        mergeContrast: 2.15,
        mergeMaxLuminance: 0.23,
        proseMinLightness: 0.81
      }
    }
  ]);

  const TAG_SKIP = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'META', 'LINK', 'HEAD', 'TITLE',
    'SVG', 'PATH', 'USE', 'DEFS', 'SOURCE', 'TRACK', 'BR', 'WBR'
  ]);
  const MEDIA_TAGS = new Set(['IMG', 'VIDEO', 'CANVAS', 'PICTURE']);
  const TEXT_TAGS = new Set([
    'A', 'P', 'SPAN', 'LI', 'DT', 'DD', 'LABEL', 'BUTTON', 'INPUT', 'TEXTAREA',
    'SELECT', 'OPTION', 'SUMMARY', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'TD',
    'TH', 'CAPTION', 'CODE', 'PRE', 'BLOCKQUOTE', 'SMALL', 'STRONG', 'EM'
  ]);
  const SURFACE_TAGS = new Set([
    'HTML', 'BODY', 'MAIN', 'SECTION', 'ARTICLE', 'ASIDE', 'NAV', 'HEADER', 'FOOTER',
    'DIV', 'FORM', 'DIALOG', 'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TD', 'TH',
    'BUTTON', 'INPUT', 'TEXTAREA', 'SELECT', 'OPTION', 'PRE', 'CODE', 'BLOCKQUOTE'
  ]);

  const state = {
    settings: { ...DEFAULTS },
    site: { enabled: true },
    profile: GENERIC_PROFILE,
    active: false,
    pageKind: 'unknown',
    queue: [],
    queued: new WeakSet(),
    scanning: false,
    observer: null,
    viewportTimer: 0,
    idleTimer: 0,
    wakeTimer: 0,
    shade: null,
    applied: new Set(),
    appliedBackground: new WeakMap(),
    pseudoInspected: new WeakSet(),
    staticElements: new Set(),
    stats: {
      scanned: 0,
      backgrounds: 0,
      gradients: 0,
      pseudos: 0,
      foregrounds: 0,
      prose: 0,
      borders: 0,
      media: 0,
      startedAt: Date.now()
    }
  };

  const host = (location.hostname || location.origin || 'local').toLowerCase();

  function detectProfile() {
    return SITE_PROFILES.find((entry) => entry.test(host))?.profile || GENERIC_PROFILE;
  }

  function storageGet(keys) {
    return new Promise((resolve) => chrome.storage.sync.get(keys, resolve));
  }

  function siteExcluded(settings) {
    return (settings.excludedSites || []).some((entry) => {
      const normalized = String(entry || '').trim().toLowerCase();
      if (!normalized) return false;
      return host === normalized || host.endsWith(`.${normalized}`);
    });
  }

  async function loadSettings() {
    const data = await storageGet(['oledForgeSettings', 'oledForgeSites']);
    state.settings = { ...DEFAULTS, ...(data.oledForgeSettings || {}) };
    state.site = { enabled: true, ...((data.oledForgeSites || {})[host] || {}) };
    state.profile = detectProfile();
  }

  function isEnabled() {
    return Boolean(state.settings.enabled && state.site.enabled && !siteExcluded(state.settings));
  }

  function resetStats() {
    state.stats = {
      scanned: 0,
      backgrounds: 0,
      gradients: 0,
      pseudos: 0,
      foregrounds: 0,
      prose: 0,
      borders: 0,
      media: 0,
      startedAt: Date.now()
    };
  }

  function hasDirectText(element) {
    if (TEXT_TAGS.has(element.tagName)) return true;
    for (const node of element.childNodes) {
      if (node.nodeType === Node.TEXT_NODE && node.nodeValue && node.nodeValue.trim().length > 0) return true;
    }
    return false;
  }

  function isProtectedRegion(element) {
    if (element.isContentEditable) return true;
    if (element.closest?.('[contenteditable="true"], [role="textbox"], .CodeMirror, .monaco-editor, .ace_editor')) return true;
    return false;
  }

  function elementRect(element) {
    if (element === document.documentElement || element === document.body) {
      return { width: innerWidth, height: innerHeight, area: innerWidth * innerHeight };
    }
    const rect = element.getBoundingClientRect();
    return { width: rect.width, height: rect.height, area: rect.width * rect.height };
  }

  function isSurfaceCandidate(element, style, rect) {
    if (SURFACE_TAGS.has(element.tagName)) return true;
    if (style.backgroundImage && style.backgroundImage !== 'none') return false;
    if (element.hasAttribute('style')) return true;
    const viewportArea = Math.max(1, innerWidth * innerHeight);
    return rect.area > viewportArea * 0.007 || rect.width > 280 || rect.height > 120;
  }

  function computedBackground(element, maxDepth = 8) {
    let current = element;
    let depth = 0;
    let accumulated = null;
    while (current && depth < maxDepth) {
      const mapped = state.appliedBackground.get(current);
      const style = getComputedStyle(current);
      const parsed = mapped || C.parseColor(style.backgroundColor);
      if (parsed && parsed.a > 0.01) {
        accumulated = accumulated ? C.compositeOver(accumulated, parsed) : parsed;
        if ((parsed.a == null ? 1 : parsed.a) >= 0.98) return accumulated;
      }
      current = current.parentElement;
      depth += 1;
    }
    return accumulated || (state.pageKind === 'light'
      ? { r: 6, g: 6, b: 8, a: 1 }
      : { r: 0, g: 0, b: 0, a: 1 });
  }

  function setVar(element, name, value) {
    if (element.style.getPropertyValue(name) !== value) element.style.setProperty(name, value);
  }

  function markApplied(element) {
    state.applied.add(element);
  }

  function pureBlack(alpha = 1) {
    return { r: 0, g: 0, b: 0, a: alpha };
  }

  function mapSurfaceForElement(element, source, rect) {
    const intensity = C.clamp(state.settings.strength / 100);
    const cutoff = C.clamp(state.settings.blackCutoff / 100, 0.02, 0.42);
    let mapped = C.mapSurface(source, {
      pageKind: state.pageKind,
      intensity,
      cutoff,
      pureBlack: state.settings.pureBlack
    });

    const parentBackground = element.parentElement ? computedBackground(element.parentElement) : null;
    if (D.shouldMergeSurface(source, parentBackground, {
      pageKind: state.pageKind,
      pureBlack: state.settings.pureBlack,
      tagName: element.tagName,
      area: rect.area,
      maxContrast: state.profile.mergeContrast,
      maxLuminance: state.profile.mergeMaxLuminance
    })) {
      mapped = C.luminance(parentBackground) < 0.018
        ? pureBlack(source.a == null ? 1 : source.a)
        : C.mix(mapped, parentBackground, 0.88);
    }
    return mapped;
  }

  function applyBackground(element, source, style, rect) {
    if (!isSurfaceCandidate(element, style, rect)) return null;

    const gradient = state.profile.cleanNeutralGradients
      ? D.analyzeGradient(style.backgroundImage, state.pageKind)
      : null;
    const effectiveSource = source && source.a >= 0.055 ? source : gradient?.average;
    if (!effectiveSource) return null;

    const sourceHsl = C.rgbToHsl(effectiveSource);
    const viewportArea = Math.max(1, innerWidth * innerHeight);
    const rootSurface = element === document.documentElement || element === document.body || element.tagName === 'MAIN';
    if (state.settings.preserveBrandColors && !rootSurface && sourceHsl.s > 0.55 && rect.area < viewportArea * 0.025) {
      return effectiveSource;
    }

    const mapped = mapSurfaceForElement(element, effectiveSource, rect);
    const changed = C.colorDistance(effectiveSource, mapped) >= 4;
    if (!changed && !gradient) return effectiveSource;

    setVar(element, '--oledforge-bg', C.toCss(mapped));
    element.classList.add('oledforge-bg');
    if (gradient) {
      element.classList.add('oledforge-neutral-gradient');
      state.stats.gradients += 1;
    }
    state.appliedBackground.set(element, mapped);
    state.stats.backgrounds += 1;
    markApplied(element);
    return mapped;
  }

  function siteProseMatch(element) {
    if (!state.profile.proseSelector) return false;
    try {
      return Boolean(element.matches(state.profile.proseSelector) || element.closest(state.profile.proseSelector));
    } catch (_error) {
      return false;
    }
  }

  function isPrimaryProse(element, style, rect) {
    const text = String(element.textContent || '').replace(/\s+/g, ' ').trim();
    if (!text) return false;
    const hint = [
      element.id,
      element.className && typeof element.className === 'string' ? element.className : '',
      element.getAttribute('role') || '',
      element.getAttribute('aria-label') || ''
    ].join(' ');
    const forced = siteProseMatch(element)
      && !/^(BUTTON|LABEL|OPTION|SUMMARY)$/i.test(element.tagName)
      && text.length >= 10;
    if (!forced && element.closest?.('nav, header, footer, [role="navigation"], [role="menu"], [role="toolbar"]')) return false;
    return D.isLikelyPrimaryProse({
      text,
      fontSize: parseFloat(style.fontSize) || 0,
      width: rect.width,
      height: rect.height,
      tagName: element.tagName,
      hint,
      forced
    });
  }

  function applyForeground(element, style, background, rect) {
    if (!hasDirectText(element)) return;
    const source = C.parseColor(style.color);
    if (!source || source.a < 0.08) return;

    const effectiveSource = C.compositeOver(source, background);
    const contrast = C.contrastRatio(effectiveSource, background);
    const baseTarget = C.clamp(Number(state.settings.targetContrast) || 7, 3, 12);
    const prose = isPrimaryProse(element, style, rect);
    const target = prose ? Math.max(baseTarget, 7.25) : baseTarget;
    const hsl = C.rgbToHsl(effectiveSource);
    if (state.settings.preserveBrandColors && hsl.s > 0.52 && contrast >= Math.min(target, 4.5)) return;

    const minimumLightness = prose && C.luminance(background) < 0.18
      ? state.profile.proseMinLightness
      : 0;
    if (contrast >= target && (!minimumLightness || !C.isNearNeutral(effectiveSource) || hsl.l >= minimumLightness)) return;

    const mapped = C.readableTextColor(source, background, {
      targetContrast: target,
      minimumLightness,
      forceOpaque: prose || source.a < 0.96
    });
    if (C.colorDistance(effectiveSource, mapped) < 3 && Math.abs((source.a ?? 1) - (mapped.a ?? 1)) < 0.04) return;

    setVar(element, '--oledforge-fg', C.toCss(mapped));
    element.classList.add('oledforge-fg');
    if (prose) {
      element.classList.add('oledforge-prose');
      state.stats.prose += 1;
    }
    state.stats.foregrounds += 1;
    markApplied(element);
  }

  function applyBorder(element, style, background) {
    const widths = [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth];
    if (!widths.some((width) => parseFloat(width) > 0)) return;
    const source = C.parseColor(style.borderTopColor);
    if (!source || source.a < 0.08) return;
    const lum = C.luminance(source);
    let mapped = source;

    if (state.pageKind === 'light' && lum > 0.25) {
      mapped = C.mix(source, { r: 74, g: 74, b: 84, a: source.a }, C.clamp(state.settings.strength / 120));
    } else if (state.pageKind === 'dark' && lum < 0.1) {
      mapped = C.mix(source, { r: 34, g: 34, b: 40, a: source.a }, 0.65);
    }

    if (C.contrastRatio(mapped, background) < 1.18) {
      mapped = C.mix(mapped, C.luminance(background) < 0.2
        ? { r: 62, g: 62, b: 72, a: mapped.a }
        : { r: 34, g: 34, b: 40, a: mapped.a }, 0.52);
    }

    if (C.colorDistance(source, mapped) < 4) return;
    setVar(element, '--oledforge-border', C.toCss(mapped));
    element.classList.add('oledforge-border');
    state.stats.borders += 1;
    markApplied(element);
  }

  function shouldInspectPseudo(element, style, rect) {
    if (!state.profile.inspectPseudoSurfaces || rect.area < 1200 || state.pseudoInspected.has(element)) return false;
    if (!SURFACE_TAGS.has(element.tagName) && style.position === 'static') return false;
    if (style.position !== 'static') return true;
    const threshold = state.profile.name === 'nexusmods' ? 5200 : 12000;
    return rect.area >= threshold || (style.backgroundImage && style.backgroundImage !== 'none');
  }

  function applyPseudoSurface(element, pseudo, rect) {
    if (!state.profile.inspectPseudoSurfaces || rect.area < 1200) return;
    const style = getComputedStyle(element, pseudo);
    if (!style || style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return;

    const gradient = state.profile.cleanNeutralGradients
      ? D.analyzeGradient(style.backgroundImage, state.pageKind)
      : null;
    const source = C.parseColor(style.backgroundColor);
    const effectiveSource = source && source.a >= 0.055 ? source : gradient?.average;
    if (!effectiveSource || !C.isNearNeutral(effectiveSource)) return;

    const positioned = style.position === 'absolute' || style.position === 'fixed' || style.position === 'sticky';
    const width = parseFloat(style.width);
    const height = parseFloat(style.height);
    const pseudoArea = Number.isFinite(width) && Number.isFinite(height) ? width * height : rect.area;
    if (!gradient && !positioned && pseudoArea < 4200) return;

    let mapped = C.mapSurface(effectiveSource, {
      pageKind: state.pageKind,
      intensity: C.clamp(state.settings.strength / 100),
      cutoff: C.clamp(state.settings.blackCutoff / 100, 0.02, 0.42),
      pureBlack: state.settings.pureBlack
    });
    if (state.pageKind === 'dark' && state.settings.pureBlack && C.isNearNeutral(effectiveSource) && C.luminance(effectiveSource) < state.profile.mergeMaxLuminance) {
      mapped = pureBlack(effectiveSource.a == null ? 1 : effectiveSource.a);
    }

    const side = pseudo === '::before' ? 'before' : 'after';
    setVar(element, `--oledforge-${side}-bg`, C.toCss(mapped));
    element.classList.add(`oledforge-${side}-bg`);
    if (gradient) element.classList.add(`oledforge-${side}-gradient`);
    state.stats.pseudos += 1;
    markApplied(element);
  }

  function applyMedia(element) {
    element.classList.remove('oledforge-media-balanced', 'oledforge-media-deep');
    if (state.settings.mediaMode === 'balanced') {
      element.classList.add('oledforge-media-balanced');
      state.stats.media += 1;
      markApplied(element);
    } else if (state.settings.mediaMode === 'deep') {
      element.classList.add('oledforge-media-deep');
      state.stats.media += 1;
      markApplied(element);
    }
  }

  function trackStaticUi(element, style, rect) {
    if (!state.settings.panelGuard) return;
    const isStatic = (style.position === 'fixed' || style.position === 'sticky') && rect.area > 7000;
    if (!isStatic) return;
    element.classList.add('oledforge-static-ui');
    state.staticElements.add(element);
    markApplied(element);
  }

  function processElement(element) {
    if (!(element instanceof Element) || TAG_SKIP.has(element.tagName)) return;
    if (!element.isConnected) return;
    state.stats.scanned += 1;

    if (MEDIA_TAGS.has(element.tagName)) {
      applyMedia(element);
      return;
    }
    if (element.tagName === 'IFRAME') return;
    if (isProtectedRegion(element)) return;

    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return;
    const rect = elementRect(element);
    if (rect.width < 1 || rect.height < 1) return;

    const sourceBg = C.parseColor(style.backgroundColor);
    const mappedBg = applyBackground(element, sourceBg, style, rect);
    const effectiveBg = mappedBg || computedBackground(element);
    applyForeground(element, style, effectiveBg, rect);
    applyBorder(element, style, effectiveBg);
    if (shouldInspectPseudo(element, style, rect)) {
      state.pseudoInspected.add(element);
      applyPseudoSurface(element, '::before', rect);
      applyPseudoSurface(element, '::after', rect);
    }
    trackStaticUi(element, style, rect);

    if (element.shadowRoot) enqueueTree(element.shadowRoot);
  }

  function scheduleDrain() {
    if (state.scanning || !state.active) return;
    state.scanning = true;
    const runner = (deadline) => {
      const profile = state.settings.performance;
      const hardLimit = profile === 'turbo' ? 900 : profile === 'eco' ? 160 : 420;
      let processed = 0;
      while (state.queue.length && processed < hardLimit) {
        if (deadline && !deadline.didTimeout && deadline.timeRemaining() < 2) break;
        const element = state.queue.shift();
        state.queued.delete(element);
        processElement(element);
        processed += 1;
      }
      if (state.queue.length && state.active) {
        requestIdleCallback(runner, { timeout: 220 });
      } else {
        state.scanning = false;
      }
    };
    requestIdleCallback(runner, { timeout: 180 });
  }

  function enqueue(element) {
    if (!(element instanceof Element) || state.queued.has(element)) return;
    state.queued.add(element);
    state.queue.push(element);
  }

  function enqueueTree(root) {
    if (!root) return;
    if (root instanceof Element) enqueue(root);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
      acceptNode(node) {
        if (TAG_SKIP.has(node.tagName)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    let current;
    while ((current = walker.nextNode())) enqueue(current);
    scheduleDrain();
  }

  function classifyPage() {
    const samples = [];
    const roots = [document.documentElement, document.body].filter(Boolean);
    for (const element of roots) {
      const color = C.parseColor(getComputedStyle(element).backgroundColor);
      if (color && color.a > 0.2) samples.push({ color, weight: 5 });
    }

    const points = [
      [0.1, 0.1], [0.5, 0.1], [0.9, 0.1],
      [0.1, 0.5], [0.5, 0.5], [0.9, 0.5],
      [0.1, 0.9], [0.5, 0.9], [0.9, 0.9]
    ];
    for (const [x, y] of points) {
      const element = document.elementFromPoint(Math.max(0, innerWidth * x), Math.max(0, innerHeight * y));
      if (!element) continue;
      const color = C.parseColor(getComputedStyle(element).backgroundColor);
      if (color && color.a > 0.2) samples.push({ color, weight: 1 });
    }

    if (!samples.length) return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    const totalWeight = samples.reduce((sum, sample) => sum + sample.weight, 0);
    const average = samples.reduce((sum, sample) => sum + C.luminance(sample.color) * sample.weight, 0) / totalWeight;
    return average < 0.32 ? 'dark' : 'light';
  }

  function viewportRescan() {
    if (!state.active) return;
    const columns = state.settings.performance === 'turbo' ? 7 : 5;
    const rows = state.settings.performance === 'eco' ? 3 : 5;
    for (let cx = 0; cx < columns; cx += 1) {
      for (let cy = 0; cy < rows; cy += 1) {
        const x = ((cx + 0.5) / columns) * innerWidth;
        const y = ((cy + 0.5) / rows) * innerHeight;
        const stack = document.elementsFromPoint(x, y).slice(0, 8);
        for (const element of stack) {
          enqueue(element);
          let parent = element.parentElement;
          for (let depth = 0; parent && depth < 3; depth += 1) {
            enqueue(parent);
            parent = parent.parentElement;
          }
        }
      }
    }
    scheduleDrain();
  }

  function scheduleViewportRescan() {
    clearTimeout(state.viewportTimer);
    state.viewportTimer = setTimeout(viewportRescan, 140);
  }

  function installObserver() {
    state.observer?.disconnect();
    state.observer = new MutationObserver((mutations) => {
      if (!state.active) return;
      for (const mutation of mutations) {
        if (mutation.type === 'childList') {
          for (const node of mutation.addedNodes) {
            if (node instanceof Element) enqueueTree(node);
          }
        }
      }
    });
    state.observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  function setupPanelGuard() {
    clearTimeout(state.idleTimer);
    document.documentElement.dataset.oledforgeIdle = 'false';
    document.documentElement.style.setProperty('--oledforge-static-opacity', String(C.clamp(state.settings.staticUiOpacity / 100, 0.35, 1)));
    document.documentElement.style.setProperty('--oledforge-idle-shade', String(C.clamp(state.settings.idleShade / 100, 0, 0.45)));

    if (!state.settings.panelGuard || Number(state.settings.idleDimMinutes) <= 0) {
      state.shade?.remove();
      state.shade = null;
      return;
    }

    if (!state.shade) {
      state.shade = document.createElement('div');
      state.shade.id = 'oledforge-idle-shade';
      document.documentElement.appendChild(state.shade);
    }

    const arm = () => {
      clearTimeout(state.idleTimer);
      document.documentElement.dataset.oledforgeIdle = 'false';
      state.idleTimer = setTimeout(() => {
        if (!state.active) return;
        document.documentElement.dataset.oledforgeIdle = 'true';
      }, Math.max(1, Number(state.settings.idleDimMinutes)) * 60_000);
    };

    if (!state.wakeTimer) {
      const wake = () => arm();
      for (const event of ['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart']) {
        addEventListener(event, wake, { passive: true });
      }
      state.wakeTimer = 1;
    }
    arm();
  }

  function clearApplied() {
    state.observer?.disconnect();
    clearTimeout(state.viewportTimer);
    clearTimeout(state.idleTimer);
    state.queue.length = 0;
    state.scanning = false;
    for (const element of state.applied) {
      if (!element?.isConnected) continue;
      element.classList.remove(
        'oledforge-bg', 'oledforge-fg', 'oledforge-prose', 'oledforge-border',
        'oledforge-neutral-gradient', 'oledforge-before-bg', 'oledforge-after-bg',
        'oledforge-before-gradient', 'oledforge-after-gradient',
        'oledforge-media-balanced', 'oledforge-media-deep', 'oledforge-static-ui'
      );
      for (const property of [
        '--oledforge-bg', '--oledforge-fg', '--oledforge-border',
        '--oledforge-before-bg', '--oledforge-after-bg'
      ]) {
        element.style.removeProperty(property);
      }
    }
    state.applied.clear();
    state.appliedBackground = new WeakMap();
    state.pseudoInspected = new WeakSet();
    state.staticElements.clear();
    state.shade?.remove();
    state.shade = null;
    document.documentElement.removeAttribute('data-oledforge-active');
    document.documentElement.removeAttribute('data-oledforge-page');
    document.documentElement.removeAttribute('data-oledforge-profile');
    document.documentElement.removeAttribute('data-oledforge-sharp-text');
    document.documentElement.removeAttribute('data-oledforge-idle');
  }

  function activate() {
    if (!isEnabled()) {
      deactivate();
      return;
    }
    state.active = true;
    resetStats();
    state.pageKind = classifyPage();
    if (state.pageKind === 'light' && !state.settings.convertLightPages) {
      state.pageKind = 'dark-only-skipped';
      deactivate(false);
      return;
    }

    const root = document.documentElement;
    root.dataset.oledforgeActive = 'true';
    root.dataset.oledforgePage = state.pageKind;
    root.dataset.oledforgeProfile = state.profile.name;
    root.dataset.oledforgeSharpText = String(Boolean(state.settings.sharpenText));
    installObserver();
    setupPanelGuard();
    enqueueTree(root);
    viewportRescan();
  }

  function deactivate(clear = true) {
    state.active = false;
    if (clear) clearApplied();
    else {
      state.observer?.disconnect();
      document.documentElement.removeAttribute('data-oledforge-active');
    }
  }

  async function reloadAndApply() {
    clearApplied();
    await loadSettings();
    if (isEnabled()) activate();
  }

  function status() {
    return {
      active: state.active,
      pageKind: state.pageKind,
      profile: state.profile.name,
      host,
      settings: state.settings,
      site: state.site,
      stats: { ...state.stats, queue: state.queue.length }
    };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message !== 'object') return undefined;
    if (message.type === 'OLED_FORGE_STATUS') {
      sendResponse(status());
      return undefined;
    }
    if (message.type === 'OLED_FORGE_RESCAN') {
      clearApplied();
      activate();
      sendResponse(status());
      return undefined;
    }
    if (message.type === 'OLED_FORGE_RELOAD') {
      reloadAndApply().then(() => sendResponse(status()));
      return true;
    }
    if (message.type === 'OLED_FORGE_TOGGLE') {
      if (state.active) deactivate(); else activate();
      sendResponse(status());
      return undefined;
    }
    return undefined;
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'sync') return;
    if (changes.oledForgeSettings || changes.oledForgeSites) reloadAndApply();
  });

  addEventListener('scroll', scheduleViewportRescan, { passive: true });
  addEventListener('resize', scheduleViewportRescan, { passive: true });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) scheduleViewportRescan();
  });

  (async () => {
    await loadSettings();
    const start = () => {
      if (!isEnabled()) return;
      activate();
      setTimeout(() => {
        if (!state.active) return;
        const nextKind = classifyPage();
        if (nextKind !== state.pageKind) {
          clearApplied();
          activate();
        } else {
          viewportRescan();
        }
      }, 900);
    };

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
      start();
    }
  })();
})();

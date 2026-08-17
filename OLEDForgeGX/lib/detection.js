(function initOLEDDetection(globalScope) {
  'use strict';

  const C = globalScope.OLEDColor || (typeof require === 'function' ? require('./color.js') : null);
  if (!C) return;

  const INTERACTIVE_TAGS = new Set(['BUTTON', 'INPUT', 'TEXTAREA', 'SELECT', 'OPTION']);

  function extractCssColors(value) {
    if (!value) return [];
    const matches = String(value).match(/rgba?\([^)]*\)/gi) || [];
    return matches.map((match) => C.parseColor(match)).filter(Boolean);
  }

  function averageColors(colors) {
    if (!colors.length) return null;
    const total = colors.reduce((sum, color) => ({
      r: sum.r + color.r,
      g: sum.g + color.g,
      b: sum.b + color.b,
      a: sum.a + (color.a == null ? 1 : color.a)
    }), { r: 0, g: 0, b: 0, a: 0 });
    return {
      r: total.r / colors.length,
      g: total.g / colors.length,
      b: total.b / colors.length,
      a: total.a / colors.length
    };
  }

  function analyzeGradient(value, pageKind = 'dark') {
    const text = String(value || '');
    const isGradient = /(?:linear|radial|conic)-gradient\(/i.test(text);
    if (!isGradient || /url\(/i.test(text)) return null;
    const colors = extractCssColors(text);
    if (colors.length < 2) return null;

    const neutral = colors.every((color) => C.isNearNeutral(color));
    const maxLum = Math.max(...colors.map(C.luminance));
    const minLum = Math.min(...colors.map(C.luminance));
    const safeRange = pageKind === 'light' ? minLum > 0.18 : maxLum < 0.38;
    if (!neutral || !safeRange) return null;

    return {
      colors,
      average: averageColors(colors),
      luminanceRange: maxLum - minLum
    };
  }

  function shouldMergeSurface(source, parent, options = {}) {
    if (!source || !parent) return false;
    const {
      pageKind = 'dark',
      pureBlack = true,
      tagName = '',
      area = 0,
      maxContrast = 1.45,
      maxLuminance = 0.19
    } = options;
    if (pageKind !== 'dark' || !pureBlack) return false;
    if (INTERACTIVE_TAGS.has(String(tagName).toUpperCase()) && area < 24000) return false;
    if (!C.isNearNeutral(source) || !C.isNearNeutral(parent)) return false;
    if (C.luminance(source) > maxLuminance || C.luminance(parent) > 0.11) return false;
    return C.contrastRatio(source, parent) <= maxContrast;
  }

  function isLikelyPrimaryProse(options = {}) {
    const {
      text = '',
      fontSize = 0,
      width = 0,
      height = 0,
      tagName = '',
      hint = '',
      forced = false
    } = options;
    if (forced) return true;
    const normalized = String(text).replace(/\s+/g, ' ').trim();
    if (normalized.length < 34 || fontSize < 12.5 || width < 180 || height < fontSize * 1.15) return false;
    const words = normalized.split(' ').filter(Boolean).length;
    if (words < 7) return false;
    if (/^(BUTTON|LABEL|OPTION|SUMMARY)$/i.test(tagName)) return false;
    if (/(?:meta|timestamp|secondary|subtext|caption|badge|byline|stat|count|tooltip|menu|nav)/i.test(hint)) return false;
    return true;
  }

  const api = {
    extractCssColors,
    averageColors,
    analyzeGradient,
    shouldMergeSurface,
    isLikelyPrimaryProse
  };

  globalScope.OLEDDetection = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

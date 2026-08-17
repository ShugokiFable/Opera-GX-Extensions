(function initOLEDColor(globalScope) {
  'use strict';

  const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));
  const round = (value) => Math.round(clamp(value, 0, 255));

  function parseColor(value) {
    if (!value || value === 'transparent') return null;
    const match = String(value).match(/rgba?\(\s*([\d.]+)(?:\s*,|\s+)\s*([\d.]+)(?:\s*,|\s+)\s*([\d.]+)(?:\s*(?:,|\/)\s*([\d.]+%?))?\s*\)/i);
    if (!match) return null;
    const alphaRaw = match[4];
    const alpha = alphaRaw == null
      ? 1
      : alphaRaw.endsWith('%')
        ? clamp(parseFloat(alphaRaw) / 100)
        : clamp(parseFloat(alphaRaw));
    return {
      r: round(Number(match[1])),
      g: round(Number(match[2])),
      b: round(Number(match[3])),
      a: alpha
    };
  }

  function toCss(color) {
    if (!color) return '';
    if (color.a != null && color.a < 0.999) {
      return `rgba(${round(color.r)}, ${round(color.g)}, ${round(color.b)}, ${clamp(color.a).toFixed(3)})`;
    }
    return `rgb(${round(color.r)}, ${round(color.g)}, ${round(color.b)})`;
  }

  function linearize(channel) {
    const value = clamp(channel / 255);
    return value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
  }

  function luminance(color) {
    if (!color) return 0;
    return 0.2126 * linearize(color.r) + 0.7152 * linearize(color.g) + 0.0722 * linearize(color.b);
  }

  function contrastRatio(a, b) {
    const l1 = luminance(a);
    const l2 = luminance(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  }

  function rgbToHsl(color) {
    const r = color.r / 255;
    const g = color.g / 255;
    const b = color.b / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    let h = 0;
    let s = 0;
    const l = (max + min) / 2;
    const d = max - min;

    if (d !== 0) {
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      switch (max) {
        case r:
          h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
          break;
        case g:
          h = ((b - r) / d + 2) / 6;
          break;
        default:
          h = ((r - g) / d + 4) / 6;
      }
    }
    return { h, s, l, a: color.a == null ? 1 : color.a };
  }

  function hueToRgb(p, q, t) {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  }

  function hslToRgb(hsl) {
    let r;
    let g;
    let b;
    if (hsl.s === 0) {
      r = g = b = hsl.l;
    } else {
      const q = hsl.l < 0.5 ? hsl.l * (1 + hsl.s) : hsl.l + hsl.s - hsl.l * hsl.s;
      const p = 2 * hsl.l - q;
      r = hueToRgb(p, q, hsl.h + 1 / 3);
      g = hueToRgb(p, q, hsl.h);
      b = hueToRgb(p, q, hsl.h - 1 / 3);
    }
    return { r: r * 255, g: g * 255, b: b * 255, a: hsl.a == null ? 1 : hsl.a };
  }

  function channelChroma(color) {
    if (!color) return 0;
    return Math.max(color.r, color.g, color.b) - Math.min(color.r, color.g, color.b);
  }

  function isNearNeutral(color) {
    if (!color) return false;
    const maxChannel = Math.max(color.r, color.g, color.b);
    const chroma = channelChroma(color);
    const hsl = rgbToHsl(color);
    return chroma <= 12 || chroma <= Math.max(16, maxChannel * 0.14) || hsl.s < 0.18 || (luminance(color) < 0.085 && chroma <= 28);
  }

  function compositeOver(foreground, background) {
    if (!foreground) return background;
    if (!background) return foreground;
    const alpha = foreground.a == null ? 1 : clamp(foreground.a);
    return {
      r: foreground.r * alpha + background.r * (1 - alpha),
      g: foreground.g * alpha + background.g * (1 - alpha),
      b: foreground.b * alpha + background.b * (1 - alpha),
      a: 1
    };
  }

  function mix(a, b, amount) {
    const t = clamp(amount);
    return {
      r: a.r + (b.r - a.r) * t,
      g: a.g + (b.g - a.g) * t,
      b: a.b + (b.b - a.b) * t,
      a: (a.a == null ? 1 : a.a) + ((b.a == null ? 1 : b.a) - (a.a == null ? 1 : a.a)) * t
    };
  }

  function darkSurfaceTarget(color, intensity, pureBlack = true) {
    const hsl = rgbToHsl(color);
    const neutral = isNearNeutral(color);
    const blackTarget = pureBlack && neutral ? 0 : Math.min(0.035, hsl.l * 0.22);
    const target = hslToRgb({
      h: hsl.h,
      s: neutral ? hsl.s * 0.3 : Math.min(hsl.s, 0.62),
      l: blackTarget,
      a: color.a
    });
    return mix(color, target, clamp(intensity));
  }

  function lightSurfaceTarget(color, intensity) {
    const hsl = rgbToHsl(color);
    const originalLum = luminance(color);
    const targetLightness = clamp(0.025 + (1 - originalLum) * 0.095, 0.025, 0.13);
    const target = hslToRgb({
      h: hsl.h,
      s: Math.min(hsl.s * 0.55, 0.36),
      l: targetLightness,
      a: color.a
    });
    return mix(color, target, clamp(intensity));
  }

  function mapSurface(color, options = {}) {
    const {
      pageKind = 'dark',
      intensity = 0.88,
      cutoff = 0.18,
      pureBlack = true
    } = options;
    const lum = luminance(color);

    if (pageKind === 'light') {
      if (lum < 0.22) return color;
      const strength = clamp(intensity * ((lum - 0.18) / 0.82));
      return lightSurfaceTarget(color, strength);
    }

    if (lum > Math.max(cutoff * 1.7, 0.32)) return color;
    const proximity = 1 - clamp(lum / Math.max(cutoff * 1.7, 0.001));
    const strength = clamp(intensity * (0.52 + proximity * 0.48));
    return darkSurfaceTarget(color, strength, pureBlack);
  }

  function ensureContrast(foreground, background, target = 7) {
    if (!foreground || !background) return foreground;
    if (contrastRatio(foreground, background) >= target) return foreground;

    const bgLum = luminance(background);
    const source = rgbToHsl(foreground);
    const towardLight = bgLum < 0.42;
    let low = 0;
    let high = 1;
    let best = foreground;

    for (let i = 0; i < 18; i += 1) {
      const t = (low + high) / 2;
      const testLightness = towardLight
        ? source.l + (1 - source.l) * t
        : source.l * (1 - t);
      const candidate = hslToRgb({
        h: source.h,
        s: Math.min(source.s, 0.82),
        l: testLightness,
        a: source.a
      });
      if (contrastRatio(candidate, background) >= target) {
        best = candidate;
        high = t;
      } else {
        low = t;
      }
    }

    if (contrastRatio(best, background) < target) {
      return towardLight
        ? { r: 245, g: 245, b: 247, a: foreground.a }
        : { r: 12, g: 12, b: 14, a: foreground.a };
    }
    return best;
  }


  function readableTextColor(foreground, background, options = {}) {
    if (!foreground || !background) return foreground;
    const {
      targetContrast = 7,
      minimumLightness = 0,
      forceOpaque = false
    } = options;
    const effective = compositeOver(foreground, background);
    let candidate = contrastRatio(effective, background) >= targetContrast
      ? effective
      : ensureContrast(effective, background, targetContrast);

    if (minimumLightness > 0 && luminance(background) < 0.35 && isNearNeutral(effective)) {
      const hsl = rgbToHsl(candidate);
      if (hsl.l < minimumLightness) {
        candidate = hslToRgb({
          h: hsl.h,
          s: Math.min(hsl.s, 0.12),
          l: clamp(minimumLightness, 0, 0.96),
          a: 1
        });
      }
      candidate = ensureContrast(candidate, background, targetContrast);
    }

    candidate.a = forceOpaque ? 1 : (foreground.a == null ? 1 : foreground.a);
    return candidate;
  }

  function colorDistance(a, b) {
    return Math.sqrt(
      Math.pow(a.r - b.r, 2) +
      Math.pow(a.g - b.g, 2) +
      Math.pow(a.b - b.b, 2)
    );
  }

  const api = {
    clamp,
    parseColor,
    toCss,
    luminance,
    contrastRatio,
    rgbToHsl,
    hslToRgb,
    mix,
    channelChroma,
    isNearNeutral,
    compositeOver,
    mapSurface,
    ensureContrast,
    readableTextColor,
    colorDistance
  };

  globalScope.OLEDColor = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

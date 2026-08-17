'use strict';
const assert = require('node:assert/strict');
const C = require('../lib/color.js');

const black = C.parseColor('rgb(0, 0, 0)');
const white = C.parseColor('rgba(255, 255, 255, 1)');
assert.equal(C.contrastRatio(black, white).toFixed(2), '21.00');

const mappedDark = C.mapSurface(C.parseColor('rgb(22, 22, 24)'), {
  pageKind: 'dark', intensity: 1, cutoff: 0.18, pureBlack: true
});
assert.ok(C.luminance(mappedDark) < C.luminance(C.parseColor('rgb(22, 22, 24)')));
assert.ok(mappedDark.r < 4 && mappedDark.g < 4 && mappedDark.b < 4);

const mappedLight = C.mapSurface(C.parseColor('rgb(248, 248, 250)'), {
  pageKind: 'light', intensity: 0.9, cutoff: 0.18, pureBlack: true
});
assert.ok(C.luminance(mappedLight) < 0.08);

const fixed = C.ensureContrast(C.parseColor('rgb(80, 80, 80)'), black, 7);
assert.ok(C.contrastRatio(fixed, black) >= 6.99);


const tintedNeutral = C.parseColor('rgb(30, 32, 40)');
assert.ok(C.isNearNeutral(tintedNeutral));
const mappedTinted = C.mapSurface(tintedNeutral, {
  pageKind: 'dark', intensity: 1, cutoff: 0.18, pureBlack: true
});
assert.ok(C.luminance(mappedTinted) < 0.0015);

const translucentText = C.parseColor('rgba(255, 255, 255, 0.58)');
const effectiveText = C.compositeOver(translucentText, black);
assert.ok(C.luminance(effectiveText) < C.luminance(white));
const liftedText = C.readableTextColor(translucentText, black, {
  targetContrast: 7.25,
  minimumLightness: 0.84,
  forceOpaque: true
});
assert.equal(liftedText.a, 1);
assert.ok(C.rgbToHsl(liftedText).l >= 0.839);
assert.ok(C.contrastRatio(liftedText, black) >= 7.24);

const roundTrip = C.hslToRgb(C.rgbToHsl(C.parseColor('rgb(120, 40, 200)')));
assert.ok(C.colorDistance(roundTrip, C.parseColor('rgb(120, 40, 200)')) < 1.2);

console.log('color tests passed');

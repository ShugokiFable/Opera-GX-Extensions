# OLED Forge GX

OLED Forge GX is a local-only Manifest V3 extension for Opera GX and Chromium browsers. It maps eligible webpage surfaces toward OLED black, rebuilds light pages without whole-page inversion, and repairs text contrast after each color change.

## What it does

- **True-black surface mapping:** neutral and subtly tinted near-black backgrounds can become literal `#000`.
- **Surface harmonizer:** merges low-contrast nested cards, neutral gradients, and safe pseudo-element overlays into a consistent OLED-black surface cluster.
- **Adaptive light-page conversion:** remaps individual backgrounds and foregrounds instead of inverting the entire page.
- **Contrast guard:** composites translucent text correctly, recalculates foreground colors, and raises long-form prose above a readability floor without bleaching brand colors.
- **Protected media:** images, video, canvas, SVG, editors, and content-editable regions are untouched by default.
- **Optional media depth:** Balanced and Deep Cinema filters are explicit opt-ins.
- **Dynamic-page support:** mutation batches and viewport rescans handle feeds, SPAs, and lazy-loaded content.
- **Per-site controls:** pause the engine on a hostname without disabling it globally.
- **Panel guard:** optional idle shade and fixed-UI dimming for webpage content.
- **No telemetry:** no analytics, remote API, account, or network service.

## Install in Opera GX

1. Extract the source folder.
2. Open `opera://extensions`.
3. Enable **Developer mode**.
4. Choose **Load unpacked** and select the `OLEDForgeGX` folder.
5. Pin **OLED Forge GX**.

A self-signed CRX is also included in the release output. Chromium-family browsers may warn about manually installed CRX files; loading the unpacked folder is the most reliable developer installation method.

## Recommended presets

- **Balanced:** daily use, media untouched.
- **Native Black:** maximum neutral-surface black capture.
- **Cinema:** deeper optional media filter and lower text contrast target.
- **Reading:** gentler surfaces with stronger text contrast.

## Keyboard shortcut

`Alt+Shift+O` toggles OLED Forge on the current page. The shortcut can be changed in the browser extension shortcut settings.

## Technical boundaries

A browser extension cannot modify monitor firmware, Windows HDR calibration, OLED compensation cycles, the Opera GX browser interface, or protected DRM video pixels. OLED Forge changes normal webpage rendering only. CSS-filter media modes may affect subtitles embedded in video frames.

## 1.0.1 detection update

- Stronger Nexus Mods handling for nested grey cards and decorative overlays.
- YouTube description prose is lifted independently from secondary metadata.
- Neutral CSS gradients and safe `::before` / `::after` surfaces can be collapsed without touching image backgrounds.
- Semi-transparent text is measured against its real composited color instead of being mistaken for opaque white.
- Pseudo-element inspection is cached and gated to surface candidates to limit layout work.

## Development

```bash
npm test
npm run check
```

## License

MIT

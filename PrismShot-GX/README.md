# PrismShot GX

A dark, modern Manifest V3 extension for capturing high-quality still frames from HTML video in Opera GX and Chromium browsers.

## Core capture engine

PrismShot GX uses two complementary paths:

1. **Clean source capture** draws the decoded video frame directly to a canvas at the video's native dimensions. This avoids player controls, page overlays, browser zoom loss, and rendered letterboxing.
2. **Visible capture fallback** screenshots the active tab and crops the exact on-screen player rectangle. This can preserve captions, CSS filters, and player overlays, and works when cross-origin media blocks canvas extraction.

**Auto hybrid** tries the clean source path first and automatically falls back to visible capture.

## Features

- Native-resolution source-frame capture when the browser permits it
- Precise visible-player fallback across nested and cross-origin frames
- PNG, WebP, and JPEG output
- Native, 2x, 4K, and 8K output modes with safe canvas limits
- High-quality browser resampling
- Optional restrained clarity boost
- Optional black-bar trimming
- Optional site, media-time, and date watermark
- Download, clipboard, or combined output
- Configurable folders and filename templates
- 1, 3, 5, or 10-frame burst capture
- Approximate previous/next-frame controls using live frame-rate estimation
- Automatic video selection based on visibility, playback state, size, and recent interaction
- Video discovery inside normal documents, iframes, and open Shadow DOM
- Isolated on-video toolbar with capture, copy, and frame-step controls
- Keyboard shortcuts and video context-menu actions
- Local recent-capture gallery with compact thumbnails
- No telemetry, advertising, remote code, or external runtime dependencies

## Install in Opera GX

1. Extract `PrismShot-GX.zip` to a permanent folder.
2. Open `opera://extensions`.
3. Enable **Developer mode**.
4. Choose **Load unpacked**.
5. Select the extracted `PrismShot-GX` folder containing `manifest.json`.
6. Pin PrismShot GX from the extensions menu.
7. Reload video tabs that were already open when the extension was installed.

## Fast controls

- **Ctrl+Shift+S**: save the active video frame
- **Ctrl+Shift+X**: copy the active video frame
- **Ctrl+Shift+V**: toggle the on-video toolbar

Opera GX lets you rebind these at `opera://extensions/shortcuts`.

## Capture modes

### Auto hybrid

Best default. Attempts a clean source frame and falls back to a visible crop if the media origin or player blocks canvas extraction.

### Clean source

Highest-quality decoded video pixels. It does not include browser-rendered captions, player controls, CSS filters, masks, or page overlays. A protected or cross-origin player may reject this path.

### What you see

Captures the rendered player rectangle from the active tab. Use it for captions, filters, overlays, or players that block direct extraction. The video must be visible in the active browser tab.

## Filename tokens

- `{title}` page title
- `{site}` site hostname
- `{date}` local capture date
- `{timestamp}` local date and clock time
- `{time}` video playback position
- `{width}` output width
- `{height}` output height
- `{resolution}` output dimensions
- `{engine}` source or visible engine
- `{index}` burst frame number

## Privacy

All capture, processing, history, and settings work locally in the browser. PrismShot GX does not send frames, URLs, titles, settings, or analytics to any server. See `PRIVACY.md`.

## Browser and media boundaries

PrismShot GX does **not** bypass DRM, HDCP, encrypted-media protections, protected GPU surfaces, account access controls, or browser security boundaries. Protected video may deliberately appear black in screenshots or reject source-frame canvas access.

HTML video seeking is often keyframe-dependent. The frame-step buttons estimate frame duration from `requestVideoFrameCallback` when available, but some streams can seek near a frame rather than to an exact codec frame.

Visible-tab capture is rate-limited by Chromium, so burst intervals are clamped to at least 550 ms.

## Development validation

From the extension directory:

```bash
node tests/validate.mjs
```

The build was also validated by Chromium's extension packer before release.

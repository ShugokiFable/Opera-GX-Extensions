# Technical notes

GX Overdrive is intentionally buildless. Every file in the package is directly loadable by a Manifest V3 browser.

## Service worker

`background.js` owns browser-level operations:

- alarms
- physical-memory sampling
- tab discard decisions
- download recovery
- cache repair
- popup/dashboard messaging

## Content script

`content.js` owns page-level operations:

- lazy image hints
- offscreen muted-video pausing
- ChatGPT turn discovery and folding
- dirty-form detection
- optional rendering reductions

## Long-thread strategy

Old ChatGPT turns are not deleted or serialized. The extension keeps the original DOM nodes and applies `display: none` only to the oldest excess turns. Remaining turns use `content-visibility: auto` and an intrinsic-size estimate, which lets Chromium skip most layout and paint work outside the viewport.

This approach is less invasive than replacing React-owned nodes, and the floating toolbar can reveal folded turns in batches or restore all of them.

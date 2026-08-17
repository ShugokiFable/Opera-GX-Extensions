# Changelog

## 1.0.0

Initial release.

- Behavioural popup and popunder engine: trusted-gesture requirement, one window
  per click, per-minute ceiling, blank-shell refusal, cross-site heuristic.
- `window.open` wrapper installed at document_start in the page world, returning
  an inert stub so popunder scripts do not fall back to another technique.
- Automatic `rel="noopener"` repair on `target="_blank"` links that omit it.
- Geometry-based overlay and interstitial removal with scroll-lock release,
  available from the popup, the page context menu, and Alt+Shift+X.
- Seed declarativeNetRequest blocklist for long-running popunder networks,
  switchable independently of the behavioural engine.
- Per-site allowlist, per-tab block badge, local counters broken down by reason.
- No network requests of any kind.

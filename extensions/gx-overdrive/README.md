# GX Overdrive

A local-only Manifest V3 performance extension built for Opera GX and Chromium browsers.

## What it actually accelerates

- **Long ChatGPT conversations:** applies `content-visibility`, rendering containment, and non-destructive folding to old conversation turns.
- **RAM pressure:** reads physical memory availability through `chrome.system.memory`, selects an initial profile based on installed RAM, and discards safe, cold background tabs through `chrome.tabs.discard`.
- **Heavy pages:** lazy-decodes images, pauses muted/autoplay video after it leaves the viewport, and optionally suppresses animations, backdrop blur, or offscreen page sections.
- **Downloads:** monitors native browser downloads, attempts to resume interrupted transfers, cycles stalled resumable downloads, and can keep the system awake during active transfers.
- **Broken site caches:** provides a manual, origin-scoped cache and CacheStorage repair action.

## What it cannot do

A browser extension cannot directly program Ryzen X3D cache, DRAM timings, Infinity Fabric, SSD DRAM, ReBAR, CUDA cores, GPU scheduling, Opera GX CPU/RAM limiter internals, or the browser network stack. It also cannot create a real multi-connection download accelerator or bypass a server/CDN speed limit.

GX Overdrive targets the controls Chromium exposes to extensions instead of painting hardware words on a placebo button.

## Install in Opera GX

1. Extract the ZIP.
2. Open `opera://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select the extracted `gx-overdrive` folder.
6. Pin **GX Overdrive** to the toolbar.

## Two hibernation engines (read this if tabs keep unloading)

Tab unloading is driven by two independent engines, and turning one off does not
turn off the other:

| Engine | Setting | Fires when |
| --- | --- | --- |
| Idle timer | **Idle tab hibernation** (`autoHibernate`) | A background tab has not been touched for the cold-tab timer |
| Emergency | **RAM-pressure hibernation** (`memoryGovernor`) | Free physical memory drops under the emergency trigger |

To stop tab hibernation completely, switch **both** off in the popup, or park the
master switch. The emergency engine additionally refuses to touch any tab used
within the last *emergency idle floor* minutes and waits out the *emergency
cooldown* between sweeps, so it cannot chain-unload your working set.

Per-site exemptions: **Never hibernate this site** in the popup, the same entry
in the page context menu, or the domain list in the dashboard.

## Recommended setup for very large ChatGPT logs

- Long-chat engine: ON
- Visible conversation turns: 50 to 80
- Strip heavy chat shadows: ON
- Memory governor: ON
- Emergency trigger: 10% to 15% free RAM
- Cold-tab timer: 25 to 45 minutes
- Protect unsaved forms: ON

The first-run profile adapts automatically: systems with more physical memory keep more chat turns and wait longer before cold-tab hibernation. Every threshold remains editable in the dashboard.

## Keyboard shortcuts

- `Alt+Shift+G`: boost the current tab
- `Alt+Shift+S`: hibernate eligible background tabs

Change them at `opera://extensions/shortcuts` if Opera reports a conflict.

## Privacy

- No telemetry.
- No analytics.
- No remote code.
- No account or chat-content upload.
- Settings and counters stay in `chrome.storage.local`.

The extension requests broad site access because automatic page optimization and dirty-form protection require a content script on normal web pages. Internal browser pages remain inaccessible.

## Safety behavior

GX Overdrive does not discard active, pinned, audible, still-loading, whitelisted, non-web, browser-protected (`autoDiscardable: false`), or dirty-form tabs by default. Unsaved-form detection reads the live contents of text fields and contenteditable areas in the tab, so clearing a field makes the tab eligible again. Browser APIs may still refuse a discard or download recovery operation; those failures are handled as best-effort no-ops.

Every hibernation is logged locally (last 25) and can be restored with one click from the dashboard.

## Tests

```bash
node tests/smoke.cjs
```

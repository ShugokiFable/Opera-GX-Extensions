# PopShield GX

A local-only popup, popunder, click-hijack and interstitial blocker for Opera GX
and Chromium.

Built as a replacement for a commercial popup blocker that shipped a telemetry
host, a second API on an unrelated domain, and a remote feature-flag service —
while holding script-injection rights on every site. PopShield sends nothing,
anywhere, ever.

## How it blocks

A blocklist of ad networks is always out of date, so here it is the backup layer.
The defence is behavioural, because what actually separates a popunder from a
window you asked for is how it behaves:

| Signal | Verdict |
| --- | --- |
| No trusted click in the last second | blocked (`no-user-gesture`) |
| A second window from the same click | blocked (`extra-window-from-one-click`) |
| `about:blank` or empty target | blocked (`blank-shell`) — the shell a popunder navigates later so no URL is ever filterable |
| More windows than the per-minute ceiling | blocked (`rate-limit`) |
| Cross-site target with no gesture | blocked (`cross-site-without-gesture`) |

Only `isTrusted` events count as a gesture, which is precisely what a script
cannot fake by dispatching its own click.

The `window.open` wrapper installs at `document_start` in the page's own world,
before site scripts can cache the original. Blocked calls return a harmless stub
rather than `null`, because popunder scripts call `.focus()` and `.blur()` on the
result and treat a thrown error as a signal to retry another way.

It also adds `rel="noopener"` to `target="_blank"` links that omit it — that
missing attribute is what lets a spawned window drive your original tab.

## Overlays

Interstitials are found by geometry, not by matching words: a fixed or sticky
element covering more than 55% of the viewport with a z-index above 100. That
works regardless of the site's language. "Kill overlay" removes them and lifts
the scroll lock that usually comes with them — in the popup, the page context
menu, or `Alt+Shift+X`.

## Permissions, and why

- `<all_urls>` — a popunder blocker that only works on some sites is not a
  popunder blocker. This is inherent to the job, and it is why the extension is
  worth reading before you trust it: it is ~600 lines.
- `declarativeNetRequest` — the seed blocklist.
- `storage` — settings and local counters.
- `contextMenus` — the two right-click actions.

No `webRequest`, no `identity`, no `nativeMessaging`, no remote code, no
analytics endpoint, no account.

## What it cannot do

Popups the browser itself opens, new tabs from a middle-click, and windows
created before the content script runs in a frame are all out of reach. It is not
a general ad blocker either — that is a separate job.

## Tests

```bash
node tests/policy.test.cjs
```

The decision logic lives in `src/policy.js` with no DOM or `chrome.*`
dependencies, so the test exercises the real code rather than a copy.

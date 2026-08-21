# Changelog

## 1.3.4

Fixed
- "Sign in with Google" (and other OAuth providers) no longer dead-ends. The
  popup guard used to return `null` for any open that happened after an async
  wait - exactly when auth popups fire, once the transient user activation has
  expired. Targets pointing at known auth providers now always pass through.
- Same-origin opens without fresh activation are handed to the browser's own
  popup blocker (visible infobar with a per-site override) instead of silently
  returning `null`, which some sites caught and treated as failure - the
  suspected cause of softlocks on script-heavy sites. Cross-origin targets
  still get the hard block; that is where popunders live.

## 1.3.3

Fixed
- The "password over an unencrypted HTTP connection" warning no longer fires on
  trusted sites or loopback addresses (localhost / 127.0.0.1 / *.localhost).
  Loopback traffic never leaves the machine, and a trusted site is the user's
  accepted risk. Every other HTTP host still warns.

## 1.3.2

Fixed
- Trusted sites no longer get downloads blocked. Three subsystems ignored the
  "Trust this site" allowlist entirely:
  - the dangerous-download auto-cancel now looks up the download's origin
    (referrer, then final URL, then URL - blob: URLs included, which is how
    ChatGPT hands out generated files) and leaves allowlisted origins alone;
  - the `automaticDownloads` content-setting block-all now writes per-site
    `allow` patterns for every allowlisted domain, so scripted downloads from
    trusted pages work despite the global clamp;
  - the popup guard content script is no longer registered on allowlisted
    sites (`excludeMatches`), so `window.open` stays stock there.
  All three route through one shared `isAllowlistedHost` matcher.

## 1.3.1

Fixed
- Saving settings failed with `Duplicate script ID 'aegis-isolated'`.
  `chrome.scripting.unregisterContentScripts` is atomic: passing it the full
  list of guard ids when only some of them are registered made it reject the
  whole call and remove nothing, so the register that followed collided with
  the guard that was still in place. Aegis now asks the browser which scripts
  it actually holds and unregisters only those. This is why the error appeared
  on the second save rather than the first.
- Two saves in quick succession could race to claim the same script ids.
  Guard registration is now serialised.

Notes
- The test mock for `chrome.scripting` always resolved, so it could not have
  caught this. It now reproduces the browser's real contract - both calls
  validate every id up front and reject the whole batch, changing nothing, if
  one id is wrong - and fails against the pre-fix code with the exact error
  above.
- All four bundled test suites (validate, self_test, api_contract, adshield)
  pass.

## 1.3.0

Added
- "Why was this blocked?" panel in the options page. It reads the browser's own
  recent declarativeNetRequest match log and lists which ruleset and rule id
  fired, on which host, and when - so a broken site can be traced to the rule
  responsible instead of guessed at.
- `declarativeNetRequestFeedback` permission, which is what makes that log
  readable.

Notes
- The browser retains roughly the last five minutes of matches and discards the
  rest, so refresh the panel right after reproducing the breakage.
- `onRuleMatchedDebug` would give a richer live stream but never fires for a
  packed (.crx) install, so the on-demand read is used instead. It works
  identically whether Aegis is loaded unpacked or installed from a .crx.
- All four bundled test suites (validate, self_test, api_contract, adshield)
  pass unchanged.
## 1.2.0

- Added an independently toggleable Stealth Ad Shield.
- Added Network-only, Adaptive, and Aggressive YouTube protection modes.
- Added tab-scoped anti-adblock recovery while retaining threat protections.
- Split advertising intelligence from malware and phishing intelligence.
- Preserved Secure Relay, WebRTC leak protection, privacy controls, download defense, LAN shielding, and permission firewalling from 1.1.0.
- Added validation for ruleset independence and YouTube isolation.

## 1.1.0

- Added trusted HTTP, HTTPS, SOCKS4, and SOCKS5 relay routing.
- Added fastest-endpoint benchmarking, verified failover, and fail-closed PAC routing.
- Added privacy controls, permission firewalling, public-IP checks, and panic cleanup.

## 1.0.0

- Initial Manifest V3 release with threat feeds, phishing heuristics, dangerous-download defense, privacy hardening, and configurable protection profiles.

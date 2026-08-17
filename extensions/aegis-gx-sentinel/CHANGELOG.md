# Changelog

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

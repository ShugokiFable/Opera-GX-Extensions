# Changelog

## 1.0.2

Fixed
- "Sign in with Google" (and other OAuth providers) no longer gets caught by
  the heuristics. Auth popups open after async token round-trips - outside the
  one-second gesture window, sometimes as a blank shell that is navigated
  later. Targets pointing at known auth providers now always pass through.
  The dot boundary is enforced: `evil.accounts.google.com.example.net` does
  not match `accounts.google.com`.

## 1.0.1

Fixed
- "Allow popups on this site" now reaches the network blocklist layer. The
  per-site allowlist previously only disabled the behavioural `window.open`
  engine; the DNR blocklist (popads, popcash, exoclick, adsterra, ...) kept
  killing the site's popup scripts regardless. One dynamic `allow` rule
  (priority 2147483647, `initiatorDomains` = allowlist) is now synced from
  `applyRulesets` whenever settings or the allowlist change.
- Removed the UTF-8 BOM from `rules/popup_networks.json`. The file began with
  `EF BB BF`, which is not JSON whitespace; whether Chromium's DNR ruleset
  parser tolerates it is unverified, so the 12 network rules are now shipped
  byte-clean instead.

# Changelog

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

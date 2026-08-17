# Privacy

PopShield GX makes no network requests.

- No telemetry, no analytics, no crash reporting.
- No remote configuration or feature flags.
- No accounts, no sign-in, no identity APIs.
- No remote code execution; every script ships in the package.

Stored locally via `chrome.storage.local`, never transmitted:

- Your settings and the list of sites you allowed.
- Counters: how many windows were blocked, by reason, and when the last block
  happened. These are numbers, not URLs.

The extension never records which sites you visit. Blocked-window reasons are
counted in aggregate; the target URL is used to make the decision and then
discarded.

Uninstalling removes all of it.

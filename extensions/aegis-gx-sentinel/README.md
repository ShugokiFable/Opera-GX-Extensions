# Aegis GX Sentinel 1.2.0

A local-first Manifest V3 defensive extension for Opera GX and Chromium browsers.

## Stealth Ad Shield

Version 1.2 separates advertising controls from the main security shield. The ad blocker can remain active while phishing, privacy, and permission controls are paused, or be disabled without releasing malware-domain rules.

### General ad blocking

- Chromium-native `declarativeNetRequest` blocking, with no remote executable code.
- Curated static rules for major advertising, auction, sponsored-content, and click-redirect services.
- Optional HaGeZi Pro mini domain intelligence compiled locally into batched dynamic rules.
- General ad rules explicitly exclude YouTube initiators so YouTube has a genuinely independent switch.
- Ad-only per-site allowlist that does not disable phishing, malware, cryptomining, or LAN-probe protection.
- Separately toggleable cosmetic cleanup, sponsored-placement cleanup, and anti-adblock overlay cleanup.
- Top-level ad-click redirect blocking for known ad redirector domains.

### Optional YouTube Ad Shield

YouTube protection is disabled by default and has three modes:

1. **Network-only**: blocks dedicated ad and measurement endpoints through DNR. It does not inject the YouTube recovery script, patch page globals, intercept `fetch`/XHR, or rewrite player responses.
2. **Adaptive**: adds an isolated-world content script that clicks visible skip controls, mutes detected ad playback, and hides promotion containers.
3. **Aggressive**: adds temporary ad fast-forward/seek behavior. This is the most breakage-prone and detectable mode.

The extension does **not** block all `googlevideo.com` requests because YouTube serves normal video media and some advertising through shared delivery infrastructure. Blanket blocking would destroy playback.

Adaptive and Aggressive modes can detect common YouTube anti-adblock enforcement dialogs. When temporary fallback is enabled, Aegis installs a tab-scoped session allow rule above ad rules but below threat rules, then reloads that tab. The bypass disappears when the tab closes or the user resumes filtering.

No blocker is literally undetectable. Sites can infer blocking from failed requests, missing ad elements, altered timing, or player behavior. Network-only mode minimizes the YouTube-specific footprint; it does not provide a guarantee against detection or future server-side ad insertion.

## Security and privacy stack

- Downloads HaGeZi Threat Intelligence mini and URLhaus host intelligence separately from the optional ad list.
- Checks top-level navigation against a local threat set.
- Scores suspicious URLs for punycode, embedded credentials, raw IPs, lure terms, obfuscation, risky zones, excessive nesting, and hidden short links.
- Cancels browser-classified dangerous downloads when enabled.
- Removes tracking parameters, hyperlink `ping`, speculative network hints, and unsafe opener relationships.
- Applies reversible controls for WebRTC, third-party cookies, Privacy Sandbox APIs, prediction, search suggestions, hyperlink auditing, referrers, Do Not Track, and Safe Browsing reporting.
- Provides a website permission firewall for notifications, geolocation, camera, microphone, and automatic multi-downloads.
- Blocks third-party private-network probing through common web request types.
- Provides Balanced, Hardened, and Lockdown profiles.
- Sends no telemetry to the developer and has no developer-operated backend.

## Secure Relay Router

The Chromium browser-proxy controller supports trusted HTTPS, HTTP, SOCKS5, and SOCKS4 endpoints. It can benchmark configured relays, select a healthy low-latency route, fail over after fatal proxy errors, omit public `DIRECT` fallback in fail-closed mode, protect WebRTC routing, and retain HTTP/HTTPS proxy passwords only for the current browser session.

A browser extension cannot create a Windows WireGuard/OpenVPN adapter or route games, Discord, launchers, torrents, or other applications. No random public proxy list is bundled.

## Install in Opera GX

1. Extract the ZIP into a permanent folder.
2. Open `opera://extensions`.
3. Enable **Developer mode**.
4. Select **Load unpacked**.
5. Choose the extracted `aegis-gx-sentinel` folder.
6. Pin the shield icon.
7. Open **Command center** and click **Update intelligence**.
8. Enable YouTube Ad Shield only when needed, beginning with Network-only mode.

When updating an existing unpacked copy, replace the old folder contents and press **Reload** on `opera://extensions`.

## Recommended configuration

- Main profile: **Hardened**
- Stealth network blocking: **On**
- HaGeZi ad intelligence: **On**
- Cosmetic cleanup: **On**, disable first on broken sites
- Anti-adblock overlay cleanup: **Off or On as needed**
- YouTube module: **Off by default**, then Network-only
- YouTube Aggressive mode: use only as a fallback
- Secure Relay: disabled until a trusted endpoint is configured

## Important limitations

Aegis cannot replace endpoint antivirus, EDR, a system firewall, or a reputable device-wide VPN. It cannot scan arbitrary encrypted response bodies or process memory, make an untrusted relay safe, hide identity after account login, prevent server-side identification, guarantee anonymity, guarantee undetectable ad blocking, or reliably remove server-side inserted advertising.

## Development validation

```bash
node tools/validate.mjs
node tools/self_test.mjs
node tools/api_contract_test.mjs
node tools/adshield_test.mjs
```

The project is GPL-3.0-or-later. Third-party data notices are in `THIRD_PARTY_NOTICES.md`.

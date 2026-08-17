# Security model

## Architecture

- Manifest V3 service worker with no persistent background page.
- Declarative network filtering for static and compiled domain rules.
- No `eval`, dynamic code generation, remote JavaScript, WebAssembly, native messaging, or developer backend.
- Threat and ad feeds are treated as data and compiled into separate priority tiers.
- Feed failures retain each source's last successfully parsed local data.
- Full trusted-site rules outrank all Aegis rules.
- Ad-only site exceptions outrank ad rules but remain below threat, cryptomining, and LAN-probe rules.
- Browser privacy and content-setting controls are cleared when their switches are disabled.

## Ad Shield isolation

- General ad rules exclude YouTube initiators, allowing YouTube filtering to be disabled independently.
- Network-only YouTube mode does not register the YouTube recovery content script.
- Adaptive and Aggressive recovery runs in the isolated extension world.
- The implementation does not monkeypatch page `fetch`, `XMLHttpRequest`, media-source APIs, or YouTube configuration/player-response objects.
- `googlevideo.com` is not blanket-blocked because it carries normal playback media.
- Temporary YouTube anti-adblock fallback is scoped to one tab and one initiator family.
- Fallback priority remains below threat and LAN-shield priorities.
- Temporary fallback rules are removed when the tab closes, the YouTube module is disabled, or filtering is manually resumed.

## Secure Relay controls

- Only HTTP, HTTPS, SOCKS4, and SOCKS5 endpoint definitions are accepted.
- Public routes omit `DIRECT` when fail-closed is enabled.
- Smart selection requires live connectivity probes.
- Fatal proxy failures test replacement candidates before failover.
- Proxy credentials are session-only and challenger-scoped.
- WebRTC non-proxied UDP protection remains forced while routing is enabled.
- No public proxy endpoints are bundled or fetched.

## Threat boundaries

Aegis assumes the browser and operating system are not already compromised. It does not protect against malicious relay operators, enterprise policy overrides, stronger privileged extensions, non-browser traffic, browser zero-days, operating-system compromise, account/payment/behavioral identification, server-side ad insertion, or every future anti-blocking technique.

A site may infer ad blocking from network failures, missing elements, or behavior changes even when no page globals are modified. “Stealth” describes a reduced and compartmentalized footprint, not invisibility.

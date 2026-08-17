# Privacy policy

Aegis GX Sentinel is local-first. It has no analytics, account system, advertising SDK, telemetry endpoint, or developer-operated backend.

## Data processed locally

The extension may process visited URLs locally for threat matching, heuristic risk analysis, ad and tracker blocking, tracking-parameter removal, popup protection, and page-level cleanup.

It stores:

- Protection, ad-block, YouTube-mode, and profile choices
- Trusted-domain, ad-only allowlist, and custom-block lists
- Downloaded threat-domain and ad-domain lists plus feed metadata
- Aggregate counters, including YouTube ads handled and anti-adblock detections
- Configured relay endpoint metadata and benchmark results
- Temporary per-tab warning and YouTube fallback records
- The last manually observed public IP when the user runs that check

Aegis does not send browsing history, page contents, form contents, cookies, or personal identifiers to the developer.

## Public list requests

When enabled, Aegis downloads text data directly from:

- `cdn.jsdelivr.net` for HaGeZi Threat Intelligence mini
- `cdn.jsdelivr.net` for the independently toggleable HaGeZi Pro mini ad and tracker list
- `urlhaus.abuse.ch` for URLhaus malware-host intelligence

Those services receive ordinary network metadata for the list request. Browsing history is not attached.

## YouTube processing

Network-only mode uses packaged and compiled DNR rules. It does not load remote code or transmit YouTube activity to the developer.

Adaptive and Aggressive modes run a packaged isolated-world script on YouTube pages. It may inspect visible player/ad state and enforcement-dialog text, click visible skip controls, mute or accelerate detected ad playback, hide promotion containers, and report aggregate local counters to the extension service worker.

When temporary anti-adblock fallback is enabled and a matching enforcement dialog is detected, Aegis creates a tab-scoped session rule that relaxes Aegis ad rules for that YouTube tab. The rule is removed when the tab closes or the user resumes filtering. It is intentionally lower priority than threat and private-network protection rules.

## Secure Relay privacy boundary

When Secure Relay is enabled, browser traffic is sent through the user-configured proxy. The relay operator may observe the source IP, timing, destination hostnames, and unencrypted HTTP traffic. Aegis does not provide or operate relay endpoints.

HTTP/HTTPS proxy passwords are stored only in `chrome.storage.session` and returned only to a matching active proxy-auth challenger. Endpoint usernames may persist as part of configuration.

## Benchmark and public-IP checks

Relay benchmarking sends small requests through configured endpoints to Google Static and Cloudflare probe URLs. The user-triggered public-IP check queries ipify and Cloudflare and stores returned addresses locally for display.

## Panic cleanup

Panic cleanup uses Chromium's browsing-data API to remove selected normal website data. It preserves Aegis settings and does not request deletion of saved passwords or autofill data.

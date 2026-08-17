# NEXUS Research privacy notes

NEXUS Research is a local browser extension. It has no developer-operated backend.

## Data sent externally

When you run research, the extension sends the following to OpenRouter:

- Your prompt
- Recent messages in the active local research session
- Any page or tab context you explicitly enabled
- A visible screenshot when Vision is enabled
- Request configuration such as model, tools, reasoning, and provider privacy preferences

OpenRouter and the selected model providers process those requests under their own policies. NEXUS exposes per-request controls for provider data-collection denial and Zero Data Retention routing.

## Local data

The extension stores settings, cached model metadata, and research sessions in Chromium extension storage. The API key is session-only by default. It is stored persistently only when you explicitly enable that option.

## Browser access

The extension uses active-page access after user interaction. Optional all-site access is requested only when you choose to extract multiple background tabs. You can revoke that permission in NEXUS settings or the browser extension manager.

## No hidden collection

NEXUS includes no analytics, telemetry, advertising, remote code, tracking pixels, or developer backend. Exported files are created locally through the browser Downloads API.

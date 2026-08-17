# NebulaGrab Privacy Policy

NebulaGrab has no telemetry, advertising, analytics, cloud relay, or account service.

The extension observes page markup and matching network request/response metadata to identify media. When resilient companion downloads are enabled, it may temporarily retain selected request headers such as Referer, Cookie, or Authorization in extension memory so the user's chosen download can use the same authorized browser session. These sensitive headers are not written to extension storage and are sent only to the user-configured localhost companion after the user starts a download.

The companion binds to `127.0.0.1`, requires a pairing token, redacts sensitive header values from logs, and does not persist received Cookie or Authorization headers in cache metadata. Optional Smart Fetch browser-cookie access is disabled by default and runs locally through yt-dlp when explicitly enabled by the user.

Downloaded files and temporary cache fragments remain on the user's computer. NebulaGrab does not sell, transmit, or share browsing data with a remote service.

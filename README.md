# Opera GX Extensions

Seven local-first Manifest V3 extensions for Opera GX and Chromium, plus the
one-command toolchain that signs and packages them.

Everything here is local-only: no telemetry, no analytics, no remote code.

## The extensions

| Extension | Version | What it does |
| --- | --- | --- |
| [GX Overdrive](gx-overdrive) | 1.2.0 | Performance governor: two-engine tab hibernation, long-chat folding for ChatGPT/Claude/Gemini/Perplexity, media throttling, download recovery |
| [Aegis GX Sentinel](aegis-gx-sentinel) | 1.3.0 | Privacy and threat shield: stealth ad/tracker blocking, phishing and malware defence, leak protection, per-rule block log |
| [NebulaGrab](NebulaGrab-OperaGX-v1.3.0) | 1.3.1 | Media detector with resumable downloads, HLS/DASH fragment capture, Smart Fetch |
| [Nocturne Scrollbars GX](nocturne-scrollbars-gx) | 1.1.0 | Dark modern scrollbars with presets, per-site profiles, adaptive contrast |
| [NEXUS Research](NEXUS-Research) | 1.0.1 | Deep web research through OpenRouter with page intelligence and citations |
| [OLED Forge GX](OLEDForgeGX) | 1.0.1 | True-black OLED treatment |
| [PrismShot GX](PrismShot-GX) | 1.0.0 | Video frame capture |

## Install

Grab the `.crx` for what you want from [Release](Release) and drag it onto
`opera://extensions`.

Chrome, Edge and Brave reject any `.crx` that lacks a Web Store publisher
signature, so on those browsers use the `.zip`: unpack it, then
`opera://extensions` equivalent → Developer mode → Load unpacked.

## Build

```
_Deploy\Build.cmd
```

One command. It validates every manifest, signs a `.crx` and `.zip` per
extension into `Release\`, writes `SHA256SUMS.txt`, and reports what your browser
is running against what was just built. It uses Opera's own packer — no OpenSSL,
no third-party signing tools. Node.js is used only to derive a public key.

To ship an update: raise `version` in that extension's `manifest.json`, run
`Build.cmd`, drag the new `.crx` in. Same key plus a higher version is an
in-place update, so settings, toolbar position and permissions survive.

### Signing keys

Each extension has a private key in `_Deploy\keys\`, which is **gitignored and
must stay that way**. The matching public key is pinned in the manifest as
`key`, so the extension ID comes from the key rather than from an install path —
which is what lets the same source folder be loaded unpacked and shipped as a
`.crx` under one identity.

Lost a key? The next build mints a fresh one automatically and tells you it did.
The only consequence is that the new `.crx` installs alongside the old copy
instead of updating it, so you remove the old card once.

## Layout

```
<extension folders>/   one copy of each, the single source of truth
Release/               signed .crx + .zip + SHA256SUMS.txt
_Deploy/               Build.cmd and its scripts
_Deploy/keys/          private signing keys (never committed)
```

## Licence

Per-extension; see the `LICENSE` file inside each folder where present.

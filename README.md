# Opera GX Extensions

Seven local-first Manifest V3 extensions for Opera GX and Chromium, plus the
one-command toolchain that signs and packages them.

No telemetry, no analytics, no remote code, no accounts.

## Install

Download the `.crx` for what you want from [Release](Release) and drag it onto
`opera://extensions`.

| Extension | Version | What it does |
| --- | --- | --- |
| [GX Overdrive](extensions/gx-overdrive) | 1.2.0 | Performance governor: two-engine tab hibernation, long-chat folding for ChatGPT/Claude/Gemini/Perplexity, media throttling, download recovery |
| [Aegis GX Sentinel](extensions/aegis-gx-sentinel) | 1.3.0 | Privacy and threat shield: stealth ad/tracker blocking, phishing and malware defence, leak protection, per-rule block log |
| [NebulaGrab](extensions/nebulagrab) | 1.3.1 | Media detector with resumable downloads, HLS/DASH fragment capture, Smart Fetch |
| [Nocturne Scrollbars GX](extensions/nocturne-scrollbars-gx) | 1.1.0 | Dark modern scrollbars with presets, per-site profiles, adaptive contrast |
| [NEXUS Research](extensions/nexus-research) | 1.0.1 | Deep web research through OpenRouter with page intelligence and citations |
| [OLED Forge GX](extensions/oled-forge-gx) | 1.0.1 | True-black OLED treatment |
| [PrismShot GX](extensions/prismshot-gx) | 1.0.0 | Video frame capture |

Chrome, Edge and Brave reject any `.crx` without a Web Store publisher
signature. On those, use the `.zip`: unpack it, then Developer mode → Load
unpacked.

## Build

```
Build.cmd
```

One command. It validates every manifest, signs a `.crx` and `.zip` per
extension into `Release\`, writes `SHA256SUMS.txt`, and reports what your
browser is running against what was just built.

It uses Opera's own packer — no OpenSSL, no third-party signing tools. Node.js
is used only to derive a public key from a signing key.

To ship an update: raise `version` in that extension's `manifest.json`, run
`Build.cmd`, drag the new `.crx` in. Same key plus a higher version is an
in-place update, so settings, toolbar position and permissions survive.

## Layout

```
extensions/     one folder per extension - the single source of truth
Release/        signed .crx + .zip + SHA256SUMS.txt
tools/          build.ps1, pubkey.cjs
tools/keys/     private signing keys - gitignored, never published
sources/        build inputs that are not loadable extensions
_archive/       superseded copies, gitignored
```

`sources/nexus-research-ts` is the TypeScript project behind NEXUS. Its shipped
bundle is committed under `extensions/nexus-research`; rebuild it with:

```
cd sources/nexus-research-ts && npm install && npm run build
```

## Signing keys

Each extension has a private key in `tools/keys/`, which is **gitignored and
must stay that way**. The matching public key is pinned in the manifest as
`key`, so an extension's ID comes from the key rather than from an install path.
That is what lets the same folder be loaded unpacked and shipped as a `.crx`
under one identity, and what makes folder renames harmless.

Lost a key? The next build mints a fresh one automatically and tells you it did.
The only consequence is that the new `.crx` installs alongside the old copy
instead of updating it, so you remove the old card once.

## Licence

Per-extension; see the `LICENSE` file inside each folder where present.

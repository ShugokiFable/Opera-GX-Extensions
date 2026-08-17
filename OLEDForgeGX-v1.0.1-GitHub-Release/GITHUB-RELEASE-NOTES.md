# OLED Forge GX 1.0.1

Smarter surface and prose detection for OLED rendering on Opera GX and Chromium browsers.

## Fixed

- Nexus Mods nested card surfaces now merge more consistently instead of leaving isolated grey blocks.
- Neutral CSS gradients and safe decorative `::before` / `::after` overlays are detected and collapsed into the mapped OLED surface.
- YouTube description prose receives a dedicated clarity floor while secondary metadata and saturated links remain differentiated.
- Semi-transparent text is now evaluated after compositing it over the detected background, fixing cases where grey text was mistaken for opaque white.

## Performance safeguards

- Pseudo-element inspection is limited to plausible surface containers.
- Pseudo results are cached for the page session.
- Image-backed gradients, media, SVG, canvas, editors, and branded saturated gradients remain protected.

## Public assets

- `OLEDForgeGX-v1.0.1-OperaGX-CRX3.crx`: signed production package.
- `OLEDForgeGX-v1.0.1-source.zip`: complete tracked source tree.
- `OLEDForgeGX-v1.0.1.github.bundle`: clone-ready Git repository with history.
- `OLEDForgeGX-CRX3-PUBLIC-KEY.pem`: public signing key.
- `CRX3-VERIFICATION.json`: signature, identity, manifest, and ZIP verification report.
- `SHA256SUMS.txt`: hashes for all public release assets.

## Identity

- Extension ID: `kckdigjpcjjfnalmjlcdgemfcmfillbd`
- Manifest: V3
- Version: 1.0.1
- Package: CRX3, SHA-256 with RSA

The private signing key is intentionally excluded. Future updates must use the same private key to retain this extension ID.

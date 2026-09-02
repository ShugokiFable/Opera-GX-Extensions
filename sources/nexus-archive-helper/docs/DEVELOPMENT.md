# Development

## Requirements

- Node.js 20 or newer
- Chrome/Chromium for signed `.crx` packaging
- PowerShell 5+ on Windows for the convenience build scripts

There are no runtime npm dependencies.

## First setup

```powershell
npm install
npm run verify
```

## Project layout

- `src/core.js` parses Nexus references and normalizes file data.
- `src/browser-resolver.js` contains API-resolution logic shared by both front ends.
- `src/extension/` is the Manifest V3 Chromium UI/background/content-script source.
- `src/userscript/` is the Tampermonkey front end and metadata template.
- `tests/` contains Node's built-in test-runner tests.
- `scripts/build.js` builds both front ends into `dist/`.
- `scripts/release.js` creates release ZIPs, userscript, checksums, and optionally a signed CRX.
- `private/signing-key.pem` is the CRX identity key and is ignored by Git.

## Edit and test

Edit files under `src/`, then run:

```powershell
npm test
npm run build
npm run verify:build
```

Or all at once:

```powershell
npm run verify
```

## Load the extension during development

Run `npm run build`, then open `chrome://extensions` or `opera://extensions`, enable Developer mode, choose **Load unpacked**, and select:

`dist/extension`

After editing source files, rebuild and click the extension's Reload button.

## Versioning

`package.json` is the only version source. Source files use `__VERSION__` tokens that are stamped during build.

```powershell
npm run version:set -- 1.2.0
npm run verify
```

## Working inside `Opera-GX-Extensions`

When this project lives at `sources/nexus-archive-helper`, run:

```powershell
npm run sync:opera
```

That runs the full verification suite and then replaces:

`extensions/nexus-archive-helper`

with the freshly built Manifest V3 extension. Keep the private signing key at:

`tools/keys/nexus-archive-helper.pem`

Then run the repository-root `Build.cmd` to create the signed `.crx` and `.zip` with the same extension identity.

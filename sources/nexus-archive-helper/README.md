# Nexus Archive Helper

A Chromium/Opera extension and Tampermonkey userscript for resolving Nexus Mods file records through the official Nexus API, with archive-first tooling for old files, archived records, unavailable mod pages, and known file IDs.

![Nexus Archive Helper icon](src/extension/icons/icon128.png)

## Features

- One-click scan of the current Nexus mod page.
- Resolve Nexus URLs, `nxm://` links, `game:modId`, and `game:modId:fileId` references.
- Surfaces AVAILABLE, ARCHIVED, OLD VERSION, DELETED-category, inferred HIDDEN, and UNKNOWN records.
- Exact-file lookup can still work when the normal mod listing is unavailable, if Nexus still exposes that record.
- Official Nexus download-link attempt with normal Nexus page/NXM fallback when direct access is not authorized.
- Local API-key storage, recent history, rate-limit display, context-menu resolver, in-page scan button, and archive-count toolbar badge.
- No background archive crawling while you browse.

## Install

### Chromium / Opera / Edge

Use the `.crx` from Releases when your browser accepts self-hosted CRX installation. Otherwise download the `Chromium.zip`, extract it, open your browser's extensions page, enable Developer mode, and choose **Load unpacked**.

### Tampermonkey

Install the `.user.js` release artifact.

## Nexus API key

Open **Settings** in the extension, paste a Nexus Personal API key, and choose **Save + test**. The key is stored in browser local extension storage and sent only to the Nexus API.

## Development

```powershell
npm install
npm run verify
npm run build
```

Then load `dist/extension` as an unpacked extension.

For Windows, `build-release.cmd` performs the full verified signed release build using `private/signing-key.pem`.

See:

- [Development guide](docs/DEVELOPMENT.md)
- [CRX signing and identity](docs/SIGNING.md)
- [Release guide](docs/RELEASING.md)

## Versioning

`package.json` is the single source of truth. Build-time `__VERSION__` tokens keep the manifest, popup, API headers, and userscript metadata synchronized.

```powershell
npm run version:set -- 1.2.0
npm run verify
```

## What it cannot do

This is a resolver, not file reconstruction. If Nexus has permanently removed the bytes and exposes no authorized download route, the helper reports that outcome instead of fabricating a link.

## Security

Never commit `private/signing-key.pem`. The public key can safely remain in the repository. See [SIGNING.md](docs/SIGNING.md).

## License

MIT

### Opera-GX-Extensions monorepo

When checked out under `sources/nexus-archive-helper` in the `Opera-GX-Extensions` repository, use `npm run sync:opera`, then run the repository root `Build.cmd`. Put the private key at `tools/keys/nexus-archive-helper.pem` so updates keep the same extension ID.

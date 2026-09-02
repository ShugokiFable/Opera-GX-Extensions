# CRX signing and extension identity

## Private key

The canonical CRX private key is `private/signing-key.pem` in the private dev kit. It is intentionally ignored by Git.

**Do not commit or upload the private key to a public repository.** Anyone with it can create a CRX carrying the same self-hosted extension identity.

Keep at least two backups somewhere you control.

## Public identity

The safe-to-publish public key is `public-key.pem`.

Current public-key SHA-256:

`b1f4b026c12457eaa687238cbb2631ec3e609d5e6f42007de4b50ac6f0344a24`

Current Chromium extension ID derived from that key:

`lbpelacgmbcefhokkgihdimllcgdbom`

Keeping the same private key keeps that self-hosted extension identity stable across CRX releases.

## Local signed build

On Windows, double-click:

`build-release.cmd`

Or run:

```powershell
npm run release -- --key private/signing-key.pem
```

If Chrome is installed in a nonstandard location, set `CHROME_PATH` first:

```powershell
$env:CHROME_PATH = 'D:\Apps\Chrome\Application\chrome.exe'
npm run release -- --key private/signing-key.pem
```

## Monorepo builds

When the project lives at `sources/nexus-archive-helper` in Opera-GX-Extensions,
copy the key to `tools/keys/nexus-archive-helper.pem` (gitignored) and run
`npm run sync:opera`, then the repo-root `tools/build.ps1`.

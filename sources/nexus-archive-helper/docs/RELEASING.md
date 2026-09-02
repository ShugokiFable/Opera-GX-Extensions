# Releasing

## Local release

1. Set the new version:

```powershell
npm run version:set -- 1.2.0
```

2. Verify everything:

```powershell
npm run verify
```

3. Build the signed release:

```powershell
.\build-release.ps1
```

Outputs appear in `release/`:

- `Nexus-Archive-Helper-vX.Y.Z.crx`
- `Nexus-Archive-Helper-vX.Y.Z-Chromium.zip`
- `Nexus-Archive-Helper-vX.Y.Z.user.js`
- `Nexus-Archive-Helper-vX.Y.Z-Source.zip`
- `SHA256SUMS.txt`

## GitHub release

Once `CRX_PRIVATE_KEY_B64` is configured in repository Actions secrets:

```powershell
git add .
git commit -m "release: v1.2.0"
git tag v1.2.0
git push origin main --tags
```

The `release.yml` workflow verifies the project, reconstructs the signing key only inside the runner, produces the signed CRX and other packages, and attaches them to the GitHub Release.

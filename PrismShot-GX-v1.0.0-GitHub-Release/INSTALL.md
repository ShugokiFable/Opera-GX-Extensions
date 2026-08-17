# Installation

## Packed CRX3

1. Download `PrismShot-GX-v1.0.0.crx`.
2. Open `opera://extensions` in Opera GX.
3. Enable Developer Mode.
4. Try dropping the CRX file onto the extensions page and approve the installation prompt.

Browser policy can restrict externally hosted CRX installation. If Opera GX refuses the packed file, use the unpacked method below.

## Unpacked fallback

1. Download and extract `PrismShot-GX-v1.0.0-source.zip` to a permanent folder.
2. Open `opera://extensions`.
3. Enable Developer Mode.
4. Choose **Load unpacked**.
5. Select the extracted `PrismShot-GX` folder containing `manifest.json`.
6. Reload video tabs that were already open.

## Verify the download

From PowerShell:

```powershell
Get-FileHash .\PrismShot-GX-v1.0.0.crx -Algorithm SHA256
```

Compare the output with `SHA256SUMS.txt`.

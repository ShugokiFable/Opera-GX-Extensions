# Opera GX tuning companion

GX Overdrive cannot change Opera GX's private settings, so use this checklist once.

## GX Control

- Disable the **Network Limiter** when maximum download speed matters.
- Do not leave the **RAM Limiter** or **CPU Limiter** below what your workload needs. A low limiter can fight the browser while GX Overdrive is trying to preserve responsiveness.
- Treat Hot Tabs Killer as a manual emergency tool. GX Overdrive already automates safe background-tab discarding.

## Graphics

- Keep hardware acceleration enabled when your GPU driver is stable.
- If scrolling or video produces corruption, flashing, or crashes, test with hardware acceleration disabled before blaming the extension.
- Avoid stacking several extensions that all inject global animation, video, or page-style rules.

## Downloads

- VPNs, proxy tunnels, antivirus HTTPS inspection, and GX's Network Limiter can reduce throughput or break resumable range requests.
- Native browser recovery depends on the source server supporting resume/range requests. GX Overdrive cannot force support from a server that does not provide it.
- For very large transfers, leave **Keep system awake during active downloads** enabled.

## ChatGPT

Start with 60 to 90 visible turns on a 32 to 64 GiB system. Lower it to 30 to 50 when a conversation contains many images, code blocks, canvases, or embedded tools.

The floating **GX Long-Thread Engine** control can reveal old turns in batches or restore everything for browser search and copying.

## What not to do

- Do not schedule constant cache purges. Browser cache usually improves repeat-load speed.
- Do not enable aggressive containment, global animation suppression, and blur suppression everywhere unless a site is actually heavy.
- Do not expect a browser extension to expose Ryzen cache topology, tune memory timings, or redirect downloads into SSD DRAM.

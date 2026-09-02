const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }
function existsFile(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }

function findChromium() {
  const envCandidates = [process.env.CHROME_PATH, process.env.CHROMIUM_PATH].filter(Boolean);
  const win = process.env;
  const candidates = [
    ...envCandidates,
    ...(process.platform === 'win32' ? [
      win.LOCALAPPDATA && path.join(win.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      win.PROGRAMFILES && path.join(win.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      win['PROGRAMFILES(X86)'] && path.join(win['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
      win.LOCALAPPDATA && path.join(win.LOCALAPPDATA, 'Chromium', 'Application', 'chrome.exe'),
      win.PROGRAMFILES && path.join(win.PROGRAMFILES, 'Chromium', 'Application', 'chrome.exe'),
      win.PROGRAMFILES && path.join(win.PROGRAMFILES, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ] : [
      '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ])
  ].filter(Boolean);
  return candidates.find(existsFile) || null;
}

function run(cmd, args, options = {}) {
  const out = spawnSync(cmd, args, { stdio: 'inherit', ...options });
  if (out.error) throw out.error;
  if (out.status !== 0) throw new Error(`${cmd} exited with code ${out.status}`);
}

function zipDirectory(sourceDir, outputZip) {
  ensureDir(path.dirname(outputZip));
  fs.rmSync(outputZip, { force: true });
  if (process.platform === 'win32') {
    const src = path.join(sourceDir, '*').replaceAll("'", "''");
    const dst = outputZip.replaceAll("'", "''");
    run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `Compress-Archive -Path '${src}' -DestinationPath '${dst}' -Force`]);
  } else {
    run('zip', ['-qr', outputZip, '.'], { cwd: sourceDir });
  }
}

function packCrx(extensionDir, keyPath, chromePath = findChromium()) {
  if (!existsFile(keyPath)) throw new Error(`Signing key not found: ${keyPath}`);
  if (!chromePath) throw new Error('Chrome/Chromium not found. Install Chrome or set CHROME_PATH.');
  const crxPath = `${extensionDir}.crx`;
  fs.rmSync(crxPath, { force: true });
  const args = [
    `--pack-extension=${extensionDir}`,
    `--pack-extension-key=${keyPath}`,
  ];
  if (process.platform === 'linux' && typeof process.getuid === 'function' && process.getuid() === 0) args.unshift('--no-sandbox');
  run(chromePath, args);
  if (!existsFile(crxPath)) throw new Error(`Chromium did not produce ${crxPath}`);
  return crxPath;
}

function copySourceTree(root, dest) {
  const excludedTop = new Set(['.git', 'dist', 'release', '.tmp-release', 'node_modules']);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(root, dest, {
    recursive: true,
    filter(src) {
      const rel = path.relative(root, src);
      if (!rel) return true;
      const parts = rel.split(path.sep);
      if (excludedTop.has(parts[0])) return false;
      if (rel === path.join('private', 'signing-key.pem')) return false;
      return true;
    },
  });
}

module.exports = { findChromium, zipDirectory, packCrx, copySourceTree, run };

const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const next = String(process.argv[2] || '').trim();
if (!/^\d+\.\d+\.\d+$/.test(next)) {
  console.error('Usage: npm run version:set -- 1.2.0');
  console.error('Chromium Manifest V3 releases use numeric x.y.z versions here.');
  process.exit(2);
}
for (const rel of ['package.json', 'package-lock.json']) {
  const p = path.join(root, rel);
  if (!fs.existsSync(p)) continue;
  const obj = JSON.parse(fs.readFileSync(p, 'utf8'));
  obj.version = next;
  if (obj.packages && obj.packages['']) obj.packages[''].version = next;
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n');
}
console.log(`Version set to ${next}. Run npm run verify before releasing.`);

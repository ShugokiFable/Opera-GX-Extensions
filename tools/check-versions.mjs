// Every extension's manifest version must match its row in the root README
// table, and its version_name (when present) must start with that version -
// version_name is what the browser actually displays, so a stale one makes a
// correctly updated install report the wrong number.
//   node tools/check-versions.mjs
import fs from 'node:fs';

const readme = fs.readFileSync('README.md', 'utf8');
let bad = 0;

for (const dir of fs.readdirSync('extensions')) {
  const manifestPath = `extensions/${dir}/manifest.json`;
  if (!fs.existsSync(manifestPath)) continue;
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  const row = readme.match(new RegExp(String.raw`\(extensions/${dir}\)\s*\|\s*([0-9][0-9.]*)\s*\|`));
  if (!row) {
    console.error(`FAIL ${dir}: no row in the README table`);
    bad += 1;
  } else if (row[1] !== manifest.version) {
    console.error(`FAIL ${dir}: manifest ${manifest.version}, README ${row[1]}`);
    bad += 1;
  }

  if (manifest.version_name && !String(manifest.version_name).startsWith(manifest.version)) {
    console.error(`FAIL ${dir}: version_name "${manifest.version_name}" does not start with ${manifest.version}`);
    bad += 1;
  }
}

if (bad) process.exit(1);
console.log('versions in sync: manifests, version_name, and the README table');

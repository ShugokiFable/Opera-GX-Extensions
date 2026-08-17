'use strict';
// Prints the manifest "key" value and the resulting extension ID for a private
// key PEM, so the unpacked copy and the signed .crx end up with the same identity.
//   node pubkey.cjs <path-to.pem>
const fs = require('node:fs');
const crypto = require('node:crypto');

const pem = process.argv[2];
if (!pem) {
  console.error('usage: node pubkey.cjs <path-to.pem>');
  process.exit(2);
}

const der = crypto.createPublicKey(fs.readFileSync(pem)).export({ type: 'spki', format: 'der' });

// Chromium derives the ID from the first 128 bits of SHA-256 over the DER public
// key, rendered in a 16-letter alphabet instead of hex.
const digest = crypto.createHash('sha256').update(der).digest('hex').slice(0, 32);
const id = [...digest].map((c) => String.fromCharCode(parseInt(c, 16) + 97)).join('');

process.stdout.write(JSON.stringify({ key: der.toString('base64'), id }));

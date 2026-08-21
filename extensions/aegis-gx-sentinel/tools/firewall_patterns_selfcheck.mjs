// Self-check: trusted-site contentSettings pattern generation (mirrors applyPermissionFirewall).
// normalizeDomain mirrors the service worker's real one (strips "*." prefixes).
const normalizeDomain = (v) => String(v || '').trim().toLowerCase().replace(/^\*\./, '');
const allowlist = ['chatgpt.com', '*.openai.com', ''];
const allowPatterns = allowlist.map(normalizeDomain).filter(Boolean)
  .flatMap(entry => [`https://*.${entry}/*`, `https://${entry}/*`]);
console.assert(allowPatterns.length === 4, 'empty entries dropped');
console.assert(allowPatterns[0] === 'https://*.chatgpt.com/*', 'subdomain pattern');
console.assert(allowPatterns[2] === 'https://*.openai.com/*' && allowPatterns[3] === 'https://openai.com/*', 'star entry normalized');
console.log('firewall pattern self-check OK:', allowPatterns.join(' | '));

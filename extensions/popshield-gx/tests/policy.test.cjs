'use strict';

// Runs the real src/policy.js, no mocks of the logic under test.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const context = vm.createContext({ URL, Date, Math, Number, Array, String, Object });
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'policy.js'), 'utf8'), context, { filename: 'policy.js' });
const policy = context.PopShieldPolicy;

const page = 'https://example.com/article';
const config = { ...policy.DEFAULTS };
let now = 1_000_000;

// A real click followed immediately by one window.open is what an honest
// "open in new tab" looks like.
let state = policy.createState();
policy.noteGesture(state, now);
let verdict = policy.evaluateOpen(state, config, { now: now + 50, pageUrl: page, targetUrl: 'https://example.com/gallery' });
assert.equal(verdict.allow, true, 'genuine click-driven popup is allowed');
policy.recordOpen(state, now + 50);

// The same click must not yield a second window.
verdict = policy.evaluateOpen(state, config, { now: now + 60, pageUrl: page, targetUrl: 'https://ads.example.net/x' });
assert.equal(verdict.allow, false);
assert.equal(verdict.reason, 'extra-window-from-one-click');

// A timer firing long after the click is the classic popunder.
state = policy.createState();
policy.noteGesture(state, now);
verdict = policy.evaluateOpen(state, config, { now: now + 4000, pageUrl: page, targetUrl: 'https://ads.example.net/x' });
assert.equal(verdict.allow, false);
assert.equal(verdict.reason, 'no-user-gesture');

// about:blank shells are refused even with a fresh gesture, because the URL
// only appears after the window exists.
state = policy.createState();
policy.noteGesture(state, now);
verdict = policy.evaluateOpen(state, config, { now: now + 10, pageUrl: page, targetUrl: 'about:blank' });
assert.equal(verdict.allow, false);
assert.equal(verdict.reason, 'blank-shell');

verdict = policy.evaluateOpen(state, config, { now: now + 10, pageUrl: page, targetUrl: '' });
assert.equal(verdict.reason, 'blank-shell', 'empty target is the same shell trick');

// Rate limit survives a user who really is clicking.
state = policy.createState();
for (let i = 0; i < config.maxOpensPerMinute; i += 1) {
  policy.noteGesture(state, now + i * 10);
  const ok = policy.evaluateOpen(state, config, { now: now + i * 10, pageUrl: page, targetUrl: `https://example.com/${i}` });
  assert.equal(ok.allow, true, `open ${i} within limit`);
  policy.recordOpen(state, now + i * 10);
}
policy.noteGesture(state, now + 100);
verdict = policy.evaluateOpen(state, config, { now: now + 100, pageUrl: page, targetUrl: 'https://example.com/last' });
assert.equal(verdict.allow, false);
assert.equal(verdict.reason, 'rate-limit');

// Allowlisting is by host and covers subdomains.
state = policy.createState();
verdict = policy.evaluateOpen(state, { ...config, allowlist: ['example.com'] }, { now, pageUrl: 'https://shop.example.com/a', targetUrl: 'about:blank' });
assert.equal(verdict.allow, true, 'allowlisted site bypasses every rule');
assert.equal(verdict.reason, 'site-allowlisted');

// Disabling must actually disable.
verdict = policy.evaluateOpen(policy.createState(), { ...config, enabled: false }, { now, pageUrl: page, targetUrl: 'about:blank' });
assert.equal(verdict.allow, true, 'disabled shield allows everything');

assert.equal(policy.isAllowlisted('deep.sub.example.com', ['*.example.com']), true, 'wildcard prefix is tolerated');
assert.equal(policy.isAllowlisted('notexample.com', ['example.com']), false, 'suffix match must respect the dot boundary');

console.log('PopShield policy test: PASS');

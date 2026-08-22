// Self-check for nativeDiscardAllowed + the sync decision table.
// Run: node tools/native_discard_selfcheck.mjs
const DEFAULTS = { enabled: true, autoHibernate: true, memoryGovernor: true };
const allowed = (s) => Boolean(s.enabled && (s.autoHibernate || s.memoryGovernor));

const cases = [
  [DEFAULTS, true, 'everything on'],
  [{ ...DEFAULTS, autoHibernate: false }, true, 'governor still on'],
  [{ ...DEFAULTS, memoryGovernor: false }, true, 'auto-hibernate still on'],
  [{ ...DEFAULTS, autoHibernate: false, memoryGovernor: false }, false, 'both hibernation switches off'],
  [{ ...DEFAULTS, enabled: false }, false, 'master off'],
  [{ ...DEFAULTS, enabled: false, memoryGovernor: true }, false, 'master off beats sub-switch']
];
for (const [settings, want, name] of cases) {
  const got = allowed(settings);
  console.assert(got === want, `FAIL ${name}: got ${got}`);
}
console.log('native-discard self-check OK:', cases.length, 'cases');

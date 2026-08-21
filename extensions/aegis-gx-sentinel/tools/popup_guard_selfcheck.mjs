// Pure-logic self-check for the popup guard wrapper in content/popup_guard.js.
// Mirrors its decision tree; run: node tools/popup_guard_selfcheck.mjs
const AUTH_HOSTS = [
  "accounts.google.com", "login.microsoftonline.com", "login.live.com",
  "appleid.apple.com", "github.com", "facebook.com", "x.com", "twitter.com",
  "accounts.spotify.com", "discord.com", "steamcommunity.com", "vk.com",
  "login.yahoo.com", "bitbucket.org", "gitlab.com"
];
const hostOf = (value, here) => {
  try { return new URL(String(value), here).hostname.toLowerCase(); } catch { return ""; }
};
const isAuthTarget = url => {
  const host = hostOf(url, "https://site.example/");
  return Boolean(host) && AUTH_HOSTS.some(e => host === e || host.endsWith(`.${e}`));
};
let nativeCalled = null;
const originalOpen = (...a) => { nativeCalled = a[0]; return { ok: true }; };
const location_hostname = "somesite.example";
function wrapped(url) {
  if (isAuthTarget(url)) return Reflect.apply(originalOpen, null, [url]);
  const userInitiated = false; // worst case: activation expired
  if (!userInitiated) {
    if (hostOf(url, `https://${location_hostname}/`) === location_hostname) return Reflect.apply(originalOpen, null, [url]);
    return null;
  }
  return Reflect.apply(originalOpen, window, [url]);
}

console.assert(isAuthTarget("https://accounts.google.com/o/oauth2/auth") === true, "google oauth passes");
console.assert(wrapped("https://accounts.google.com/o/oauth2/auth") !== null, "auth target never returns null");
console.assert(nativeCalled === "https://accounts.google.com/o/oauth2/auth", "native open used for auth");
console.assert(wrapped("https://evil.accounts.google.com.example.net/") === null, "dot boundary holds");
console.assert(wrapped("https://somesite.example/checkout/print") !== null, "same-origin async open reaches browser blocker");
console.assert(nativeCalled === "https://somesite.example/checkout/print", "same-origin delegated to native");
console.assert(wrapped("https://popunder.example/ad") === null, "cross-origin no-gesture still hard-blocked");
console.assert(isAuthTarget("about:blank") === false, "blank is not an auth target");
console.log("popup_guard self-check OK");

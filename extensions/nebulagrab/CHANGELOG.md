# Changelog

## 1.3.1

Fixed
- Settings arrived from a message and were written through completely unchecked.
  `helperUrl` is the one that matters: the companion token is sent to it as a
  request header, so an unvalidated value is a way to hand that token to an
  arbitrary host. It is now parsed, restricted to http/https, and reduced to its
  origin. Numeric settings are clamped, booleans coerced, the download folder
  sanitised, and the container/browser fields pattern-checked.
- The cached settings object was never invalidated when storage changed outside
  the SAVE_SETTINGS path, so the worker could keep serving a stale copy.

Changed
- The `onBeforeRequest` and `onHeadersReceived` listeners fire for every request
  on every tab. Both now reject the two cheap cases synchronously before awaiting
  anything, so a page pulling 400 assets with capture disabled no longer queues
  400 microtasks and a settings read each.

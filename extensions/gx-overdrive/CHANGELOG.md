# Changelog

## 1.2.2

Fixed
- 1.2.1's opt-out never reached tabs opened after the toggle, so hibernation
  still appeared to be on. The sync cached the last value it had applied and
  returned early when it matched, which cancelled the whole point of running
  it on the minute tick: a tab opened later starts browser-discardable, so the
  state to repair is exactly the state the cache called "already correct".
  The tab query already filters to tabs on the wrong setting, so the cache
  bought nothing - it is gone, and steady state is one query that returns
  empty.

Notes
- The smoke test's `tabs.query` mock ignored the `url` and
  `autoDiscardable` filters and returned every tab, so it could not have
  caught this. It now applies both, and fails against 1.2.1.
- Whether `autoDiscardable: false` suppresses Opera GX's own tab sleeping is
  not verified here - it is the documented Chromium contract, and Opera is a
  Chromium fork, but that is inference, not evidence. If tabs still sleep with
  all Overdrive hibernation off, the browser's own setting is the culprit:
  check GX Control and `opera://settings` for tab sleeping / memory saver.
  The dashboard's hibernation log tells the two apart - a tab that is asleep
  but absent from that log was slept by the browser, not by Overdrive.

## 1.2.1

Fixed
- Disabling hibernation now actually disables it. Overdrive's own toggles
  always gated its sweeps, but Opera's built-in tab sleeping / Chromium memory
  saver kept discarding tabs under memory pressure regardless - the browser
  does not consult extension settings. Every web tab is now opted out of
  native discarding (`tabs.update(autoDiscardable: false)`) whenever all
  hibernation is off (master off, or both "Auto-hibernate stale tabs" and
  "RAM Governor" off), and opted back in when any of them is re-enabled.
  The state re-asserts on startup and each minute-tick so tabs opened after a
  change are covered too.

Notes
- The context-menu / `Alt+Shift+S` "Hibernate other tabs" action remains a
  deliberate manual override: it hibernates even when automatic modes are off,
  but still honours pinned, audible, whitelisted, and unsaved-form protection.

## 1.2.0



Added
- The long-thread engine is no longer ChatGPT-only. Host profiles now cover
  Claude, Gemini, Google AI Studio, and Perplexity alongside ChatGPT, each with
  its own ordered list of candidate turn selectors.

Changed
- Turn detection tries each candidate selector in order and accepts the first
  that yields at least four matches. A site redesign therefore degrades to "no
  folding" instead of folding whatever else happened to match, and any page of a
  chat app with no conversation on it is left alone.
- A malformed selector is caught per-candidate rather than taking the whole
  content script down.

Known limitation
- Only the ChatGPT selectors are verified against the live DOM. The other four
  are best-effort: if folding does not engage on one of them the selector list
  for that host needs one correction in `content.js` (`CHAT_HOSTS`), and nothing
  else breaks in the meantime.

## 1.1.0

Fixed
- Tab hibernation could not be switched off from the popup. The popup's only
  hibernation toggle drove the RAM-pressure engine, while the independent
  idle-timer engine (`autoHibernate`) kept unloading tabs. Both engines are now
  exposed in the popup and each one really stops its own sweep.
- The emergency sweep ignored how recently a tab was used, so under sustained
  memory pressure it discarded a fresh batch every 60 seconds, including the tab
  the user had just switched away from. It now requires a minimum idle age
  (`pressureMinIdleMinutes`) and honours a cooldown (`pressureCooldownMinutes`)
  that survives service-worker restarts.
- "Protect unsaved forms" latched on the first keystroke and never cleared, so a
  tab that once had anything typed into a search box could never hibernate. The
  content script now checks live field contents instead of a sticky flag.
- Offscreen muted videos were paused and never resumed when scrolled back into
  view.
- A page that never answered `GX_CAN_DISCARD` could stall an entire governor
  pass; the probe now times out after 750 ms.
- Concurrent stat writes from the governor and the download watcher could lose
  counts; writes are serialised.
- `releaseKeepAwake()` was called even when no keep-awake was ever requested.
- The badge kept showing a stale memory reading after hibernation was disabled.
- `tests/smoke.cjs` could not run on Windows (malformed `file://` path); it now
  resolves `background.js` with `path.join`.

Added
- "Never hibernate this site" toggle in the popup and in the page context menu,
  wired to the whitelist handlers that previously had no UI at all.
- Recently-hibernated audit list in the dashboard with one-click restore.
- Emergency idle floor and emergency cooldown sliders in the dashboard.
- Tabs marked non-auto-discardable by the browser or another extension, and
  tabs still loading, are now left alone.
- Regression coverage in `tests/smoke.cjs` for the disable gate, the sweep
  cooldown, the idle floor, restore, and site protection.

Changed
- `minimum_chrome_version` raised to 121, the first version that ships
  `tabs.lastAccessed`, which the cold-tab timer depends on.
- Guard-rail settings (`maxHibernatePerCycle`, `emergencyDiscardBatch`) are now
  clamped like every other numeric setting.
- Manual "hibernate other tabs" now works even when the master switch is parked;
  it still honours pinned, audible, whitelist, and unsaved-form guards.

## 1.0.0

- Added physical-memory pressure governor.
- Added safe cold-tab hibernation with pinned, audible, whitelist, and dirty-form guards.
- Added ChatGPT long-thread rendering containment and old-turn folding controls.
- Added lazy image decoding and offscreen muted-video pausing.
- Added optional animation, blur, and aggressive section reduction modes.
- Added interrupted and stalled native-download recovery.
- Added origin-scoped cache repair.
- Added popup, full dashboard, context menu commands, and keyboard shortcuts.

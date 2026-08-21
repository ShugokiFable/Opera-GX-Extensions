(() => {
  const originalOpen = window.open;

  // OAuth sign-in popups open after async token round-trips (transient user
  // activation long gone). Real popunders never target auth providers.
  const AUTH_HOSTS = [
    "accounts.google.com", "login.microsoftonline.com", "login.live.com",
    "appleid.apple.com", "github.com", "facebook.com", "x.com", "twitter.com",
    "accounts.spotify.com", "discord.com", "steamcommunity.com", "vk.com",
    "login.yahoo.com", "bitbucket.org", "gitlab.com"
  ];

  function hostOf(value) {
    try { return new URL(String(value), location.href).hostname.toLowerCase(); } catch { return ""; }
  }

  function isAuthTarget(url) {
    const host = hostOf(url);
    return Boolean(host) && AUTH_HOSTS.some(entry => host === entry || host.endsWith(`.${entry}`));
  }

  Object.defineProperty(window, "open", {
    configurable: true,
    writable: true,
    value(...args) {
      // Auth popups always pass through, gesture or not.
      if (isAuthTarget(args[0])) {
        return Reflect.apply(originalOpen, window, args);
      }
      const activation = navigator.userActivation;
      const userInitiated = activation ? activation.isActive : true;
      if (!userInitiated) {
        // Same-origin opens go to the browser's own popup blocker instead of a
        // silent null: Chrome shows its "popup blocked" infobar, whose per-site
        // override gives async in-page flows an escape hatch. Cross-origin
        // targets get the hard block; that is where popunders live.
        if (hostOf(args[0]) === location.hostname.toLowerCase()) {
          return Reflect.apply(originalOpen, window, args);
        }
        window.dispatchEvent(new CustomEvent("aegis-popup-blocked"));
        return null;
      }
      const opened = Reflect.apply(originalOpen, window, args);
      try { if (opened) opened.opener = null; } catch { /* cross-origin */ }
      return opened;
    }
  });
})();

(() => {
  try {
    Object.defineProperty(Navigator.prototype, "globalPrivacyControl", {
      configurable: true,
      enumerable: true,
      get: () => true
    });
  } catch { /* browser may already expose it */ }
})();

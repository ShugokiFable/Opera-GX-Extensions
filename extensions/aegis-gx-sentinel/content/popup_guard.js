(() => {
  const originalOpen = window.open;
  Object.defineProperty(window, "open", {
    configurable: true,
    writable: true,
    value(...args) {
      const activation = navigator.userActivation;
      const userInitiated = activation ? activation.isActive : true;
      if (!userInitiated) {
        window.dispatchEvent(new CustomEvent("aegis-popup-blocked"));
        return null;
      }
      const opened = Reflect.apply(originalOpen, window, args);
      try { if (opened) opened.opener = null; } catch { /* cross-origin */ }
      return opened;
    }
  });
})();

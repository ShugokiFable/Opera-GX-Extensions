(() => {
  const clamp = value => Math.max(1, Math.min(value, 8));
  try {
    Object.defineProperty(Navigator.prototype, "hardwareConcurrency", {
      configurable: true,
      get() { return clamp(4); }
    });
  } catch { /* ignored */ }
  try {
    Object.defineProperty(Navigator.prototype, "deviceMemory", {
      configurable: true,
      get() { return 8; }
    });
  } catch { /* ignored */ }
  try {
    Object.defineProperty(Screen.prototype, "colorDepth", { configurable: true, get: () => 24 });
    Object.defineProperty(Screen.prototype, "pixelDepth", { configurable: true, get: () => 24 });
  } catch { /* ignored */ }
})();

const DEFAULTS = Object.freeze({
  enabled: true,
  profile: "hardened",
  feeds: {
    hageziTif: true,
    urlhaus: true,
    updateHours: 6
  },
  adblock: {
    enabled: true,
    hageziAds: true,
    cosmeticFiltering: true,
    antiAdblockCleanup: true,
    sponsoredCleanup: true,
    allowlist: [],
    youtube: {
      enabled: false,
      mode: "network",
      autoFallback: true,
      hidePromotions: true,
      lastDetection: 0,
      detectionCount: 0
    }
  },
  privacy: {
    stripTrackingParams: true,
    globalPrivacyControl: true,
    doNotTrack: true,
    disableHyperlinkAuditing: true,
    disableNetworkPrediction: true,
    disablePageSpeculation: false,
    protectWebRTC: true,
    disableReferrers: false,
    blockThirdPartyCookies: true,
    disablePrivacySandbox: true,
    disableSearchSuggestions: false,
    blockLocalNetworkProbing: true,
    blockNotifications: true,
    blockGeolocation: false,
    blockCamera: false,
    blockMicrophone: false,
    blockAutomaticDownloads: true,
    popupGuard: true,
    cosmeticFiltering: true,
    annoyanceCleanup: true
  },
  security: {
    knownThreats: true,
    heuristicWarnings: true,
    heuristicThreshold: 55,
    rawIpWarnings: true,
    punycodeWarnings: true,
    dangerousDownloadAction: "cancel",
    suspiciousDownloadAction: "warn"
  },
  relay: {
    enabled: false,
    strategy: "smart",
    activeEndpointId: "",
    failClosed: true,
    bypassLocal: true,
    autoBenchmarkHours: 12,
    endpoints: [],
    lastBenchmark: 0,
    lastError: "",
    status: "off",
    activeLabel: "Direct connection",
    publicIp: "",
    publicIpCheckedAt: 0
  },
  allowlist: [],
  customBlocklist: [],
  stats: {
    domainsLoaded: 0,
    dynamicRules: 0,
    lastFeedUpdate: 0,
    lastFeedError: "",
    threatsStopped: 0,
    dangerousDownloadsStopped: 0,
    relaySwitches: 0,
    relayFailures: 0,
    panicWipes: 0,
    adDomainsLoaded: 0,
    youtubeAdsHandled: 0,
    antiAdblockDetections: 0
  }
});

const FEEDS = Object.freeze({
  hageziTif: {
    name: "HaGeZi Threat Intelligence mini",
    kind: "threat",
    url: "https://cdn.jsdelivr.net/gh/hagezi/dns-blocklists@latest/adblock/tif.mini.txt"
  },
  urlhaus: {
    name: "URLhaus",
    kind: "threat",
    url: "https://urlhaus.abuse.ch/downloads/hostfile/"
  },
  hageziAds: {
    name: "HaGeZi Pro mini ads and trackers",
    kind: "ad",
    url: "https://cdn.jsdelivr.net/gh/hagezi/dns-blocklists@latest/wildcard/pro.mini-onlydomains.txt"
  }
});

const DYNAMIC_RULE_BASE = 10000;
const YOUTUBE_BYPASS_RULE_BASE = 700000000;
const YOUTUBE_INITIATORS = ["youtube.com", "youtube-nocookie.com"];
const DYNAMIC_BATCH_SIZE = 400;
const SAFE_RESOURCE_TYPES = [
  "sub_frame", "stylesheet", "script", "image", "font", "object",
  "xmlhttprequest", "ping", "media", "websocket", "other", "csp_report"
];
const SUSPICIOUS_TLDS = new Set([
  "zip", "mov", "click", "top", "xyz", "cam", "rest", "gq", "tk", "work",
  "support", "country", "stream", "download", "xin", "quest", "fit", "buzz"
]);
const SHORTENERS = new Set([
  "bit.ly", "tinyurl.com", "t.co", "goo.gl", "cutt.ly", "rb.gy", "is.gd",
  "buff.ly", "rebrand.ly", "shorturl.at", "tiny.cc", "ow.ly", "lnkd.in"
]);
const BRAND_LURES = [
  "paypal", "microsoft", "office365", "appleid", "icloud", "steamcommunity",
  "discord", "coinbase", "binance", "metamask", "facebook", "instagram",
  "netflix", "amazon", "docusign", "onedrive", "dropbox", "google"
];
const LURE_WORDS = [
  "login", "signin", "verify", "verification", "secure", "security", "update",
  "unlock", "recover", "support", "wallet", "invoice", "payment", "billing",
  "password", "account", "auth", "authentication", "nitro", "gift", "airdrop"
];
const DANGEROUS_DOWNLOAD_TYPES = new Set([
  "file", "url", "content", "host", "unwanted", "accountCompromise",
  "sensitiveContentBlock", "deepScannedOpenedDangerous"
]);
const SUSPICIOUS_DOWNLOAD_TYPES = new Set([
  "uncommon", "asyncScanning", "passwordProtected", "deepScannedFailed",
  "promptForScanning", "promptForLocalPasswordScanning", "blockedScanFailed"
]);

let configCache = null;
let threatSetCache = null;
let feedUpdateInFlight = null;

const PROXY_SCHEMES = new Set(["http", "https", "socks4", "socks5"]);
const RELAY_PROBES = Object.freeze([
  "https://www.gstatic.com/generate_204",
  "https://cp.cloudflare.com/generate_204"
]);
const IP_PROBES = Object.freeze([
  "https://api.ipify.org?format=json",
  "https://www.cloudflare.com/cdn-cgi/trace"
]);
const proxyAuthAttempts = new Map();
let relayBenchmarkInFlight = null;
let lastProxyFailoverAt = 0;

function makeEndpointId(endpoint, index = 0) {
  const raw = `${endpoint?.scheme || ""}|${endpoint?.host || ""}|${endpoint?.port || ""}|${index}`;
  let hash = 2166136261;
  for (let i = 0; i < raw.length; i += 1) {
    hash ^= raw.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `relay-${(hash >>> 0).toString(36)}`;
}

function unwrapIpv6Hostname(hostname) {
  const host = String(hostname || "");
  if (host.startsWith("[") && host.endsWith("]") && host.includes(":")) {
    return host.slice(1, -1);
  }
  return host;
}

function parseRelayHost(raw) {
  const text = String(raw || "").trim();
  if (!text || text.length > 253 || /[\s/\\@]/.test(text)) return "";
  try {
    const bareIpv6 = text.includes(":") && !text.startsWith("[") && !text.includes(".");
    const url = new URL(`https://${bareIpv6 ? `[${text}]` : text}`);
    if (url.username || url.password || url.port) return "";
    return unwrapIpv6Hostname(url.hostname).toLowerCase();
  } catch {
    return "";
  }
}

function sanitizeEndpoint(endpoint, index = 0) {
  const source = endpoint && typeof endpoint === "object" ? endpoint : {};
  const scheme = PROXY_SCHEMES.has(String(source.scheme || "").toLowerCase())
    ? String(source.scheme).toLowerCase()
    : "https";
  const host = parseRelayHost(source.host);
  const fallbackPort = scheme === "https" ? 443 : scheme.startsWith("socks") ? 1080 : 80;
  const requestedPort = Number(source.port || fallbackPort);
  const port = Number.isInteger(requestedPort) && requestedPort >= 1 && requestedPort <= 65535
    ? requestedPort
    : fallbackPort;
  const name = String(source.name || host || `Relay ${index + 1}`).trim().slice(0, 80);
  const username = String(source.username || "").slice(0, 200);
  return {
    id: String(source.id || makeEndpointId({ scheme, host, port }, index)).slice(0, 80),
    name,
    scheme,
    host,
    port,
    username,
    enabled: source.enabled !== false,
    lastLatencyMs: Number.isFinite(Number(source.lastLatencyMs)) ? Math.max(0, Math.round(Number(source.lastLatencyMs))) : null,
    lastOk: Number(source.lastOk || 0),
    lastError: String(source.lastError || "").slice(0, 300)
  };
}

function normalizeRelayConfig(relay) {
  const out = mergeDeep(DEFAULTS.relay, relay || {});
  const seen = new Set();
  out.endpoints = (Array.isArray(out.endpoints) ? out.endpoints : [])
    .map(sanitizeEndpoint)
    .filter(endpoint => {
      const key = `${endpoint.scheme}|${endpoint.host}|${endpoint.port}`;
      if (!endpoint.host || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 12);
  out.strategy = out.strategy === "manual" ? "manual" : "smart";
  out.autoBenchmarkHours = Math.min(168, Math.max(1, Number(out.autoBenchmarkHours || 12)));
  out.failClosed = out.failClosed !== false;
  out.bypassLocal = out.bypassLocal !== false;
  if (!out.endpoints.some(endpoint => endpoint.id === out.activeEndpointId && endpoint.enabled)) {
    out.activeEndpointId = out.endpoints.find(endpoint => endpoint.enabled)?.id || "";
  }
  return out;
}


function normalizeAdblockConfig(adblock) {
  const out = mergeDeep(DEFAULTS.adblock, adblock || {});
  out.enabled = out.enabled !== false;
  out.hageziAds = out.hageziAds !== false;
  out.cosmeticFiltering = out.cosmeticFiltering !== false;
  out.antiAdblockCleanup = out.antiAdblockCleanup !== false;
  out.sponsoredCleanup = out.sponsoredCleanup !== false;
  out.allowlist = Array.from(new Set((Array.isArray(out.allowlist) ? out.allowlist : []).map(normalizeDomain).filter(Boolean))).sort();
  out.youtube = mergeDeep(DEFAULTS.adblock.youtube, out.youtube || {});
  out.youtube.enabled = Boolean(out.youtube.enabled);
  out.youtube.mode = ["network", "adaptive", "aggressive"].includes(out.youtube.mode) ? out.youtube.mode : "network";
  out.youtube.autoFallback = out.youtube.autoFallback !== false;
  out.youtube.hidePromotions = out.youtube.hidePromotions !== false;
  out.youtube.lastDetection = Number(out.youtube.lastDetection || 0);
  out.youtube.detectionCount = Number(out.youtube.detectionCount || 0);
  return out;
}
function endpointPacToken(endpoint) {
  const host = unwrapIpv6Hostname(endpoint.host);
  const address = `${host.includes(":") ? `[${host}]` : host}:${endpoint.port}`;
  if (endpoint.scheme === "https") return `HTTPS ${address}`;
  if (endpoint.scheme === "socks5") return `SOCKS5 ${address}`;
  if (endpoint.scheme === "socks4") return `SOCKS4 ${address}`;
  return `PROXY ${address}`;
}

const PAC_LOCAL_BYPASS = 'var h = String(host || "").toLowerCase(); if (isPlainHostName(h) || h === "localhost" || dnsDomainIs(h, ".localhost") || dnsDomainIs(h, ".local") || shExpMatch(h, "127.*") || shExpMatch(h, "10.*") || shExpMatch(h, "192.168.*") || shExpMatch(h, "172.16.*") || shExpMatch(h, "172.17.*") || shExpMatch(h, "172.18.*") || shExpMatch(h, "172.19.*") || shExpMatch(h, "172.2?.*") || shExpMatch(h, "172.30.*") || shExpMatch(h, "172.31.*") || h === "::1" || h.indexOf("fc") === 0 || h.indexOf("fd") === 0 || h.indexOf("fe8") === 0 || h.indexOf("fe9") === 0 || h.indexOf("fea") === 0 || h.indexOf("feb") === 0) return "DIRECT";';

function buildRelayPacScript(endpoint, relay) {
  const token = endpointPacToken(endpoint);
  const route = JSON.stringify(relay.failClosed ? token : `${token}; DIRECT`);
  const prefix = relay.bypassLocal ? PAC_LOCAL_BYPASS : "";
  return "function FindProxyForURL(url, host) { " + prefix + " return " + route + "; }";
}

async function proxyControlState() {
  if (!chrome.proxy?.settings) return { available: false, levelOfControl: "not_controllable", value: null };
  const details = await chrome.proxy.settings.get({ incognito: false });
  return { available: true, levelOfControl: details.levelOfControl, value: details.value };
}

async function setRelayProxy(endpoint, relay) {
  if (!chrome.proxy?.settings) throw new Error("This browser does not expose the Chromium proxy API.");
  const control = await proxyControlState();
  if (!["controllable_by_this_extension", "controlled_by_this_extension"].includes(control.levelOfControl)) {
    throw new Error(`Proxy settings are ${String(control.levelOfControl || "not controllable").replaceAll("_", " ")}. Disable the other proxy extension or policy first.`);
  }
  const value = {
    mode: "pac_script",
    pacScript: {
      data: buildRelayPacScript(endpoint, relay),
      mandatory: Boolean(relay.failClosed)
    }
  };
  await chrome.proxy.settings.set({ value, scope: "regular" });
}

async function clearRelayProxy() {
  if (!chrome.proxy?.settings) return;
  const control = await proxyControlState();
  if (["controllable_by_this_extension", "controlled_by_this_extension"].includes(control.levelOfControl)) {
    await chrome.proxy.settings.clear({ scope: "regular" });
  }
}

function selectedRelayEndpoint(relay) {
  return relay.endpoints.find(endpoint => endpoint.enabled && endpoint.id === relay.activeEndpointId)
    || relay.endpoints.find(endpoint => endpoint.enabled)
    || null;
}

async function applyRelayConfiguration(config, countSwitch = false) {
  config.relay = normalizeRelayConfig(config.relay);
  if (!config.relay.enabled) {
    await clearRelayProxy();
    config.relay.status = "off";
    config.relay.activeLabel = "Direct/system connection";
    config.relay.lastError = "";
    return config.relay;
  }
  const endpoint = selectedRelayEndpoint(config.relay);
  if (!endpoint) {
    config.relay.status = "error";
    config.relay.activeLabel = "No relay configured";
    config.relay.lastError = "Add at least one trusted HTTPS or SOCKS relay endpoint.";
    await clearRelayProxy();
    return config.relay;
  }
  try {
    await setRelayProxy(endpoint, config.relay);
    config.relay.activeEndpointId = endpoint.id;
    config.relay.activeLabel = endpoint.name;
    config.relay.status = endpoint.lastOk && Date.now() - endpoint.lastOk < 24 * 60 * 60 * 1000 ? "connected" : "active";
    config.relay.lastError = "";
    if (countSwitch) config.stats.relaySwitches += 1;
  } catch (error) {
    // A settings/API failure means fail-closed could not be guaranteed.
    config.relay.status = "error";
    config.relay.activeLabel = endpoint.name;
    config.relay.lastError = error.message;
    config.stats.relayFailures += 1;
    await clearRelayProxy();
  }
  return config.relay;
}

async function timedFetch(url, timeoutMs = 6500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = performance.now();
  try {
    const response = await fetch(`${url}${url.includes("?") ? "&" : "?"}aegis=${Date.now()}`, {
      cache: "no-store",
      credentials: "omit",
      redirect: "follow",
      signal: controller.signal,
      headers: { "Cache-Control": "no-cache" }
    });
    if (!response.ok && response.status !== 204) throw new Error(`HTTP ${response.status}`);
    await response.arrayBuffer();
    return Math.max(1, Math.round(performance.now() - started));
  } finally {
    clearTimeout(timer);
  }
}

async function benchmarkOneRelay(endpoint, relay) {
  await setRelayProxy(endpoint, relay);
  await new Promise(resolve => setTimeout(resolve, 250));
  const samples = [];
  const errors = [];
  for (const probe of RELAY_PROBES) {
    try { samples.push(await timedFetch(probe)); }
    catch (error) { errors.push(error.name === "AbortError" ? "Timed out" : error.message); }
  }
  if (!samples.length) throw new Error(errors.join("; ") || "No connectivity probe succeeded");
  samples.sort((a, b) => a - b);
  return Math.round(samples.reduce((sum, value) => sum + value, 0) / samples.length);
}

async function benchmarkRelays(reason = "manual", connect = true) {
  if (relayBenchmarkInFlight) return relayBenchmarkInFlight;
  relayBenchmarkInFlight = (async () => {
    const config = await getConfig();
    config.relay = normalizeRelayConfig(config.relay);
    const candidates = config.relay.endpoints.filter(endpoint => endpoint.enabled);
    if (!candidates.length) throw new Error("Add at least one relay endpoint before benchmarking.");
    const results = [];
    const previousEndpointId = config.relay.activeEndpointId;
    for (const endpoint of candidates) {
      config.relay.activeEndpointId = endpoint.id;
      try {
        const latency = await benchmarkOneRelay(endpoint, config.relay);
        endpoint.lastLatencyMs = latency;
        endpoint.lastOk = Date.now();
        endpoint.lastError = "";
        results.push({ id: endpoint.id, name: endpoint.name, ok: true, latencyMs: latency });
      } catch (error) {
        endpoint.lastLatencyMs = null;
        endpoint.lastError = error.name === "AbortError" ? "Timed out" : error.message;
        results.push({ id: endpoint.id, name: endpoint.name, ok: false, error: endpoint.lastError });
      }
    }
    const fastest = candidates
      .filter(endpoint => Number.isFinite(endpoint.lastLatencyMs))
      .sort((a, b) => a.lastLatencyMs - b.lastLatencyMs)[0];
    config.relay.lastBenchmark = Date.now();
    if (fastest) {
      config.relay.activeEndpointId = fastest.id;
      if (connect) config.relay.enabled = true;
      await applyRelayConfiguration(config, true);
    } else {
      config.relay.activeEndpointId = previousEndpointId;
      config.stats.relayFailures += 1;
      config.relay.lastError = "Every configured relay failed its connectivity test.";
      config.relay.status = config.relay.failClosed && config.relay.enabled ? "blocked" : "error";
      if (!config.relay.failClosed || !config.relay.enabled) await clearRelayProxy();
    }
    await saveConfig(config);
    return {
      ok: Boolean(fastest),
      reason,
      activeEndpointId: config.relay.activeEndpointId,
      activeLabel: config.relay.activeLabel,
      results,
      config
    };
  })().finally(() => { relayBenchmarkInFlight = null; });
  return relayBenchmarkInFlight;
}

async function checkObservedPublicIps() {
  const observed = [];
  const errors = [];
  for (const probe of IP_PROBES) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      try {
        const response = await fetch(`${probe}${probe.includes("?") ? "&" : "?"}aegis=${Date.now()}`, {
          cache: "no-store",
          credentials: "omit",
          signal: controller.signal
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const text = await response.text();
        let ip = "";
        if (probe.includes("ipify")) ip = JSON.parse(text).ip || "";
        else ip = text.split(/\r?\n/).find(line => line.startsWith("ip="))?.slice(3) || "";
        if (ip && !observed.includes(ip)) observed.push(ip);
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      errors.push(`${new URL(probe).hostname}: ${error.name === "AbortError" ? "timed out" : error.message}`);
    }
  }
  const config = await getConfig();
  config.relay.publicIp = observed.join(", ");
  config.relay.publicIpCheckedAt = Date.now();
  await saveConfig(config);
  return { ok: observed.length > 0, observed, errors, relay: config.relay };
}

async function loadRelayCredential(endpointId, username, password) {
  const id = String(endpointId || "");
  if (!id) throw new Error("Select a relay endpoint first.");
  if (!password) {
    await chrome.storage.session.remove(`relayCredential:${id}`);
    return { stored: false };
  }
  await chrome.storage.session.set({
    [`relayCredential:${id}`]: {
      username: String(username || "").slice(0, 200),
      password: String(password).slice(0, 500)
    }
  });
  return { stored: true };
}

async function applyPermissionFirewall(config) {
  // Trusted sites keep scripted downloads working despite the global block.
  const allowPatterns = (config.allowlist || [])
    .map(normalizeDomain).filter(Boolean)
    .flatMap(entry => [`https://*.${entry}/*`, `https://${entry}/*`]);
  const entries = [
    [chrome.contentSettings?.notifications, config.privacy.blockNotifications, []],
    [chrome.contentSettings?.location, config.privacy.blockGeolocation, []],
    [chrome.contentSettings?.camera, config.privacy.blockCamera, []],
    [chrome.contentSettings?.microphone, config.privacy.blockMicrophone, []],
    [chrome.contentSettings?.automaticDownloads, config.privacy.blockAutomaticDownloads, allowPatterns]
  ];
  await Promise.allSettled(entries.map(async ([setting, shouldBlock, patterns]) => {
    if (!setting) return;
    await setting.clear({ scope: "regular" });
    if (config.enabled && shouldBlock) {
      await setting.set({ primaryPattern: "<all_urls>", setting: "block", scope: "regular" });
      for (const pattern of patterns) {
        try { await setting.set({ primaryPattern: pattern, setting: "allow", scope: "regular" }); }
        catch { /* pattern rejected on this Chromium */ }
      }
    }
  }));
}

async function panicWipe(hours = 1) {
  const safeHours = Math.min(24 * 365, Math.max(0, Number(hours || 1)));
  const since = safeHours === 0 ? 0 : Date.now() - safeHours * 60 * 60 * 1000;
  await chrome.browsingData.remove({ since }, {
    cache: true,
    cacheStorage: true,
    cookies: true,
    downloads: true,
    history: true,
    indexedDB: true,
    localStorage: true,
    serviceWorkers: true,
    webSQL: true
  });
  const config = await getConfig();
  config.stats.panicWipes += 1;
  await saveConfig(config);
  return { ok: true, since };
}

function mergeDeep(base, patch) {
  const out = structuredClone(base);
  for (const [key, value] of Object.entries(patch || {})) {
    if (value && typeof value === "object" && !Array.isArray(value) && out[key] && typeof out[key] === "object" && !Array.isArray(out[key])) {
      out[key] = mergeDeep(out[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

async function getConfig(force = false) {
  if (configCache && !force) return configCache;
  const data = await chrome.storage.local.get(["config"]);
  const stored = data.config || {};
  configCache = mergeDeep(DEFAULTS, stored);
  if (stored.feeds?.hagezi !== undefined && stored.feeds?.hageziTif === undefined) {
    configCache.feeds.hageziTif = Boolean(stored.feeds.hagezi);
  }
  delete configCache.feeds.hagezi;
  if (stored.privacy?.cosmeticFiltering !== undefined && stored.adblock?.cosmeticFiltering === undefined) {
    configCache.adblock.cosmeticFiltering = Boolean(stored.privacy.cosmeticFiltering);
  }
  if (stored.privacy?.annoyanceCleanup !== undefined && stored.adblock?.antiAdblockCleanup === undefined) {
    configCache.adblock.antiAdblockCleanup = Boolean(stored.privacy.annoyanceCleanup);
  }
  configCache.adblock = normalizeAdblockConfig(configCache.adblock);
  return configCache;
}

async function saveConfig(config) {
  configCache = mergeDeep(DEFAULTS, config);
  configCache.adblock = normalizeAdblockConfig(configCache.adblock);
  delete configCache.feeds.hagezi;
  await chrome.storage.local.set({ config: configCache });
  return configCache;
}

function normalizeDomain(input) {
  if (typeof input !== "string") return "";
  let value = input.trim().toLowerCase();
  if (!value || value.startsWith("#") || value.startsWith("!") || value.startsWith("[") || value.startsWith("//")) return "";
  value = value.replace(/^address=\//, "").replace(/\/$/, "");
  value = value.replace(/^\|\|/, "").replace(/\^.*$/, "");
  value = value.replace(/^\*\./, "").replace(/^\./, "");
  const hostMatch = value.match(/^(?:0\.0\.0\.0|127\.0\.0\.1|::1)\s+([^\s#]+)/);
  if (hostMatch) value = hostMatch[1];
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    try { value = new URL(value).hostname; } catch { return ""; }
  }
  value = value.split(/[\s/#?]/)[0].replace(/:\d+$/, "");
  if (!value || value === "localhost" || value.endsWith(".localhost")) return "";
  if (value.length > 253 || !value.includes(".")) return "";
  if (!/^[a-z0-9.-]+$/.test(value) || value.includes("..") || value.startsWith("-") || value.endsWith("-")) return "";
  return value;
}

// Single matcher every trusted-site check routes through. An allowlist entry
// covers the domain and all its subdomains.
function isAllowlistedHost(config, hostname) {
  const host = String(hostname || "").toLowerCase();
  if (!host) return false;
  return (config.allowlist || []).some(item => {
    const entry = normalizeDomain(item);
    return Boolean(entry) && (host === entry || host.endsWith(`.${entry}`));
  });
}

// Downloads initiated by trusted pages (incl. blob: URLs, which is how
// ChatGPT hands out generated files) are the user's business.
function hostOfDownloadUrl(raw) {
  if (typeof raw !== "string") return "";
  const value = raw.startsWith("blob:") ? raw.slice(5) : raw;
  try { return new URL(value).hostname; } catch { return ""; }
}

async function allowlistedDownloadHost(downloadId) {
  try {
    const [item] = await chrome.downloads.search({ id: downloadId });
    if (!item) return "";
    for (const url of [item.referrer, item.finalUrl, item.url]) {
      const host = hostOfDownloadUrl(url);
      if (host) return host;
    }
  } catch { /* download already gone */ }
  return "";
}

function parseFeed(text) {
  const domains = new Set();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("!") || line.startsWith("[")) continue;
    const domain = normalizeDomain(line);
    if (domain) domains.add(domain);
  }
  return domains;
}

async function fetchText(url, timeoutMs = 30000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      cache: "no-store",
      credentials: "omit",
      redirect: "follow",
      signal: controller.signal,
      headers: { "Accept": "text/plain,*/*;q=0.5" }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} from ${new URL(url).hostname}`);
    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

function domainBatches(domains, size = DYNAMIC_BATCH_SIZE) {
  const list = Array.from(domains).sort();
  const batches = [];
  for (let i = 0; i < list.length; i += size) batches.push(list.slice(i, i + size));
  return batches;
}

function buildDynamicRules(threatDomains, adDomains, config) {
  const rules = [];
  let id = DYNAMIC_RULE_BASE;
  const fullAllowlist = Array.from(new Set((config.allowlist || []).map(normalizeDomain).filter(Boolean)));
  const adAllowlist = Array.from(new Set((config.adblock?.allowlist || []).map(normalizeDomain).filter(Boolean)));

  for (const batch of domainBatches(fullAllowlist, 500)) {
    rules.push({
      id: id++,
      priority: 30000,
      action: { type: "allowAllRequests" },
      condition: { requestDomains: batch, resourceTypes: ["main_frame", "sub_frame"] }
    });
  }

  for (const batch of domainBatches(adAllowlist, 500)) {
    rules.push({
      id: id++,
      priority: 1000,
      action: { type: "allow" },
      condition: { initiatorDomains: batch, resourceTypes: SAFE_RESOURCE_TYPES }
    });
  }

  for (const batch of domainBatches(threatDomains)) {
    rules.push({
      id: id++,
      priority: 10000,
      action: { type: "block" },
      condition: { requestDomains: batch, resourceTypes: SAFE_RESOURCE_TYPES }
    });
  }

  if (config.adblock?.enabled) {
    for (const batch of domainBatches(adDomains)) {
      rules.push({
        id: id++,
        priority: 100,
        action: { type: "block" },
        condition: {
          requestDomains: batch,
          excludedInitiatorDomains: YOUTUBE_INITIATORS,
          resourceTypes: SAFE_RESOURCE_TYPES
        }
      });
    }
  }
  return rules;
}

async function installDynamicRules(threatDomains, adDomains, config) {
  const current = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = current.filter(rule => rule.id >= DYNAMIC_RULE_BASE && rule.id < YOUTUBE_BYPASS_RULE_BASE).map(rule => rule.id);
  const addRules = (config.enabled || config.adblock?.enabled)
    ? buildDynamicRules(config.enabled ? threatDomains : new Set(), config.adblock?.enabled ? adDomains : new Set(), config)
    : [];
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
  config.stats.dynamicRules = addRules.length;
}

async function updateThreatFeeds(reason = "manual") {
  if (feedUpdateInFlight) return feedUpdateInFlight;
  feedUpdateInFlight = (async () => {
    const config = await getConfig();
    const stored = await chrome.storage.local.get(["feedCache", "feedDomains", "threatDomains", "adDomains"]);
    const feedCache = stored.feedCache && typeof stored.feedCache === "object" ? stored.feedCache : {};
    delete feedCache.hagezi;
    const threatDomains = new Set();
    const adDomains = new Set();
    const errors = [];
    const sourceCounts = {};
    let successfulSources = 0;

    const sourceEnabled = (key, source) => {
      if (source.kind === "ad") return Boolean(config.adblock?.enabled && config.adblock?.hageziAds);
      return key === "hageziTif" ? Boolean(config.feeds.hageziTif) : Boolean(config.feeds[key]);
    };

    for (const [key, source] of Object.entries(FEEDS)) {
      if (!sourceEnabled(key, source)) continue;
      try {
        const text = await fetchText(source.url);
        const parsed = parseFeed(text);
        feedCache[key] = Array.from(parsed);
        sourceCounts[key] = parsed.size;
        successfulSources += 1;
      } catch (error) {
        errors.push(`${source.name}: ${error.message}`);
        sourceCounts[key] = Array.isArray(feedCache[key]) ? feedCache[key].length : 0;
      }
    }

    for (const [key, cachedDomains] of Object.entries(feedCache)) {
      const source = FEEDS[key];
      if (!source || !sourceEnabled(key, source) || !Array.isArray(cachedDomains)) continue;
      const target = source.kind === "ad" ? adDomains : threatDomains;
      for (const domain of cachedDomains) {
        const normalized = normalizeDomain(domain);
        if (normalized) target.add(normalized);
      }
    }

    if (!threatDomains.size && errors.length) {
      for (const domain of stored.threatDomains || stored.feedDomains || []) {
        const normalized = normalizeDomain(domain);
        if (normalized) threatDomains.add(normalized);
      }
    }
    if (!adDomains.size && errors.length && config.adblock?.enabled) {
      for (const domain of stored.adDomains || []) {
        const normalized = normalizeDomain(domain);
        if (normalized) adDomains.add(normalized);
      }
    }

    const effectiveThreats = config.security.knownThreats ? new Set(threatDomains) : new Set();
    for (const domain of config.customBlocklist.map(normalizeDomain).filter(Boolean)) effectiveThreats.add(domain);
    const normalizedAllow = new Set(config.allowlist.map(normalizeDomain).filter(Boolean));
    for (const domain of normalizedAllow) effectiveThreats.delete(domain);

    await installDynamicRules(effectiveThreats, adDomains, config);
    threatSetCache = effectiveThreats;
    config.stats.domainsLoaded = effectiveThreats.size;
    config.stats.adDomainsLoaded = config.adblock?.enabled ? adDomains.size : 0;
    if (successfulSources > 0) config.stats.lastFeedUpdate = Date.now();
    config.stats.lastFeedError = errors.join(" | ");
    await chrome.storage.local.set({
      config,
      feedCache,
      threatDomains: Array.from(effectiveThreats),
      adDomains: Array.from(adDomains),
      feedMetadata: {
        reason,
        sourceCounts,
        attemptedAt: Date.now(),
        updatedAt: config.stats.lastFeedUpdate,
        errors
      }
    });
    await chrome.storage.local.remove("feedDomains");
    configCache = config;
    await updateBadgeForAllTabs();
    return {
      ok: errors.length === 0,
      domains: effectiveThreats.size,
      adDomains: config.stats.adDomainsLoaded,
      rules: config.stats.dynamicRules,
      errors,
      sourceCounts
    };
  })().finally(() => { feedUpdateInFlight = null; });
  return feedUpdateInFlight;
}

async function getThreatSet() {
  if (threatSetCache) return threatSetCache;
  const data = await chrome.storage.local.get(["threatDomains"]);
  threatSetCache = new Set((data.threatDomains || []).map(normalizeDomain).filter(Boolean));
  return threatSetCache;
}

function isPrivateOrLocalHost(hostname) {
  if (!hostname) return true;
  const bareHost = unwrapIpv6Hostname(hostname);
  if (bareHost === "localhost" || bareHost.endsWith(".localhost") || bareHost.endsWith(".local")) return true;
  if (/^127\./.test(bareHost) || /^10\./.test(bareHost) || /^192\.168\./.test(bareHost)) return true;
  const match = bareHost.match(/^172\.(\d+)\./);
  if (match && Number(match[1]) >= 16 && Number(match[1]) <= 31) return true;
  if (!bareHost.includes(":")) return false;
  return bareHost === "::1" || /^fe[89ab][0-9a-f]:/i.test(bareHost) || /^f[cd][0-9a-f]{2}:/i.test(bareHost);
}

function isIpHost(hostname) {
  const bareHost = unwrapIpv6Hostname(hostname);
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(bareHost)) {
    return bareHost.split(".").every(part => Number(part) >= 0 && Number(part) <= 255);
  }
  return bareHost.includes(":") && /^[0-9a-f:]+$/i.test(bareHost);
}

function labelEntropyScore(label) {
  if (label.length < 16) return 0;
  const unique = new Set(label).size / label.length;
  const digitRatio = (label.match(/\d/g) || []).length / label.length;
  let score = 0;
  if (unique > 0.65) score += 7;
  if (digitRatio > 0.25) score += 7;
  if (label.length > 28) score += 6;
  return score;
}

function analyzeUrl(rawUrl) {
  const result = { score: 0, reasons: [], hostname: "", knownThreat: false };
  let url;
  try { url = new URL(rawUrl); } catch { return result; }
  const host = url.hostname.toLowerCase();
  result.hostname = host;
  if (!host || isPrivateOrLocalHost(host)) return result;

  if (url.protocol !== "https:") {
    result.score += 12;
    result.reasons.push("Connection is not encrypted with HTTPS");
  }
  if (url.username || url.password) {
    result.score += 45;
    result.reasons.push("URL contains embedded credentials");
  }
  if (host.includes("xn--")) {
    result.score += 30;
    result.reasons.push("Internationalized/punycode domain can imitate familiar names");
  }
  if (isIpHost(host)) {
    result.score += 24;
    result.reasons.push("Site uses a raw IP address instead of a normal domain");
  }
  const labels = host.split(".");
  if (labels.length > 5) {
    result.score += 10;
    result.reasons.push("Unusually deep subdomain chain");
  }
  for (const label of labels) result.score += labelEntropyScore(label);
  const tld = labels.at(-1);
  if (SUSPICIOUS_TLDS.has(tld)) {
    result.score += 10;
    result.reasons.push(`Higher-risk .${tld} domain zone`);
  }
  if (SHORTENERS.has(host)) {
    result.score += 18;
    result.reasons.push("Link shortener hides the final destination");
  }
  const lowerTarget = `${host}${url.pathname}${url.search}`.toLowerCase();
  const lureMatches = LURE_WORDS.filter(word => lowerTarget.includes(word));
  if (lureMatches.length >= 2) {
    result.score += 18;
    result.reasons.push("Multiple account or payment lure terms");
  }
  const brandMatches = BRAND_LURES.filter(brand => host.includes(brand));
  if (brandMatches.length && (host.includes("-") || labels.length > 3)) {
    result.score += 24;
    result.reasons.push("Brand name appears in an unusual hostname");
  }
  if (/%(?:2f|3a|40)/i.test(rawUrl) || /https?%3a/i.test(rawUrl)) {
    result.score += 10;
    result.reasons.push("Encoded nested destination inside the URL");
  }
  if (rawUrl.length > 350) {
    result.score += 8;
    result.reasons.push("Unusually long URL");
  }
  result.score = Math.min(100, result.score);
  return result;
}

async function isBypassed(tabId, hostname) {
  const key = `bypass:${tabId}:${hostname}`;
  const data = await chrome.storage.session.get([key]);
  const expires = Number(data[key] || 0);
  if (expires > Date.now()) {
    await chrome.storage.session.remove(key);
    return true;
  }
  if (expires) await chrome.storage.session.remove(key);
  return false;
}

async function checkNavigation(details) {
  if (details.frameId !== 0 || details.tabId < 0) return;
  if (!/^https?:/i.test(details.url)) return;
  const config = await getConfig();
  if (!config.enabled) return;

  const analysis = analyzeUrl(details.url);
  if (!analysis.hostname || config.allowlist.some(item => analysis.hostname === normalizeDomain(item) || analysis.hostname.endsWith(`.${normalizeDomain(item)}`))) return;
  if (await isBypassed(details.tabId, analysis.hostname)) return;

  if (config.security.knownThreats || config.customBlocklist.length > 0) {
    const threats = await getThreatSet();
    if (threats.has(analysis.hostname) || Array.from(parentDomains(analysis.hostname)).some(domain => threats.has(domain))) {
      analysis.knownThreat = true;
      analysis.score = 100;
      analysis.reasons.unshift("Domain appears in an enabled malware/phishing/scam intelligence feed");
    }
  }

  const threshold = Number(config.security.heuristicThreshold || 55);
  const heuristicBlock = config.security.heuristicWarnings && analysis.score >= threshold;
  if (!analysis.knownThreat && !heuristicBlock) {
    await chrome.storage.session.set({ [`risk:${details.tabId}`]: analysis });
    return;
  }

  config.stats.threatsStopped += 1;
  await saveConfig(config);
  const warningUrl = new URL(chrome.runtime.getURL("warning/warning.html"));
  warningUrl.searchParams.set("target", details.url);
  warningUrl.searchParams.set("score", String(analysis.score));
  warningUrl.searchParams.set("host", analysis.hostname);
  warningUrl.searchParams.set("source", analysis.knownThreat ? "threat-feed" : "heuristic");
  warningUrl.searchParams.set("reasons", JSON.stringify(analysis.reasons.slice(0, 8)));
  await chrome.tabs.update(details.tabId, { url: warningUrl.toString() });
}

function* parentDomains(hostname) {
  const labels = hostname.split(".");
  for (let i = 1; i < labels.length - 1; i++) yield labels.slice(i).join(".");
}

async function applyPrivacySettings(config) {
  const enabled = config.enabled;
  const tasks = [];
  const setOrClear = (setting, shouldSet, value) => {
    if (!setting) return;
    tasks.push(shouldSet ? setting.set({ value, scope: "regular" }) : setting.clear({ scope: "regular" }));
  };
  setOrClear(chrome.privacy.websites?.hyperlinkAuditingEnabled, enabled && config.privacy.disableHyperlinkAuditing, false);
  setOrClear(chrome.privacy.network?.networkPredictionEnabled, enabled && config.privacy.disableNetworkPrediction, false);
  setOrClear(chrome.privacy.network?.webRTCIPHandlingPolicy, config.relay.enabled || (enabled && config.privacy.protectWebRTC), "disable_non_proxied_udp");
  setOrClear(chrome.privacy.websites?.referrersEnabled, enabled && config.privacy.disableReferrers, false);
  setOrClear(chrome.privacy.websites?.doNotTrackEnabled, enabled && config.privacy.doNotTrack, true);
  setOrClear(chrome.privacy.websites?.thirdPartyCookiesAllowed, enabled && config.privacy.blockThirdPartyCookies, false);
  setOrClear(chrome.privacy.websites?.topicsEnabled, enabled && config.privacy.disablePrivacySandbox, false);
  setOrClear(chrome.privacy.websites?.fledgeEnabled, enabled && config.privacy.disablePrivacySandbox, false);
  setOrClear(chrome.privacy.websites?.adMeasurementEnabled, enabled && config.privacy.disablePrivacySandbox, false);
  setOrClear(chrome.privacy.websites?.relatedWebsiteSetsEnabled, enabled && config.privacy.disablePrivacySandbox, false);
  setOrClear(chrome.privacy.services?.searchSuggestEnabled, enabled && config.privacy.disableSearchSuggestions, false);
  setOrClear(chrome.privacy.services?.safeBrowsingEnabled, enabled, true);
  setOrClear(chrome.privacy.services?.safeBrowsingExtendedReportingEnabled, enabled, false);
  await Promise.allSettled(tasks);
}

let guardQueue = Promise.resolve();

// Two saves in flight would each read the same "already registered" set and
// then both try to claim the same ids, so registration is serialised.
function registerContentGuards(config) {
  const run = guardQueue.then(() => applyContentGuards(config));
  guardQueue = run.catch(() => {});
  return run;
}

async function applyContentGuards(config) {
  // unregisterContentScripts is atomic: a single id that is not currently
  // registered rejects the whole call and removes nothing, which then leaves
  // registerContentScripts to fail with "Duplicate script ID". Only ever pass
  // ids the browser says it actually holds.
  let existing = [];
  try { existing = await chrome.scripting.getRegisteredContentScripts(); } catch { existing = []; }
  const stale = existing.map(script => script.id).filter(id => id.startsWith("aegis-"));
  if (stale.length) await chrome.scripting.unregisterContentScripts({ ids: stale });
  if (!config.enabled && !config.adblock?.enabled) return;
  const scripts = [{
    id: "aegis-isolated",
    matches: ["http://*/*", "https://*/*"],
    js: ["content/guard.js"],
    allFrames: true,
    runAt: "document_start",
    world: "ISOLATED",
    persistAcrossSessions: true
  }];
  if (config.enabled && config.privacy.globalPrivacyControl) scripts.push({
    id: "aegis-gpc",
    matches: ["http://*/*", "https://*/*"],
    js: ["content/gpc.js"],
    allFrames: true,
    runAt: "document_start",
    world: "MAIN",
    persistAcrossSessions: true
  });
  if (config.enabled && config.privacy.popupGuard) {
    const popupScript = {
      id: "aegis-popup",
      matches: ["http://*/*", "https://*/*"],
      js: ["content/popup_guard.js"],
      allFrames: true,
      runAt: "document_start",
      world: "MAIN",
      persistAcrossSessions: true
    };
    // Trusted sites are exempt: window.open stays stock there.
    const excluded = (config.allowlist || []).map(normalizeDomain).filter(Boolean)
      .flatMap(entry => [`https://*.${entry}/*`, `https://${entry}/*`, `http://*.${entry}/*`, `http://${entry}/*`]);
    if (excluded.length) popupScript.excludeMatches = excluded;
    scripts.push(popupScript);
  }
  if (config.enabled && config.profile === "lockdown") scripts.push({
    id: "aegis-fingerprint",
    matches: ["http://*/*", "https://*/*"],
    js: ["content/fingerprint_lockdown.js"],
    allFrames: true,
    runAt: "document_start",
    world: "MAIN",
    persistAcrossSessions: true
  });
  if (config.adblock?.enabled && config.adblock.youtube?.enabled && config.adblock.youtube.mode !== "network") scripts.push({
    id: "aegis-youtube-adshield",
    matches: ["*://youtube.com/*", "*://*.youtube.com/*", "*://youtube-nocookie.com/*", "*://*.youtube-nocookie.com/*"],
    js: ["content/youtube_adshield.js"],
    allFrames: false,
    runAt: "document_start",
    world: "ISOLATED",
    persistAcrossSessions: true
  });
  await chrome.scripting.registerContentScripts(scripts);
}

async function updateRulesetState(config) {
  const enableRulesetIds = [];
  const disableRulesetIds = [];
  if (config.enabled && config.privacy.stripTrackingParams) enableRulesetIds.push("privacy_core");
  else disableRulesetIds.push("privacy_core");
  if (config.enabled) enableRulesetIds.push("security_core");
  else disableRulesetIds.push("security_core");
  if (config.enabled && config.privacy.blockLocalNetworkProbing) enableRulesetIds.push("lan_shield");
  else disableRulesetIds.push("lan_shield");
  if (config.adblock?.enabled) enableRulesetIds.push("ad_stealth");
  else disableRulesetIds.push("ad_stealth");
  if (config.adblock?.enabled && config.adblock.youtube?.enabled) enableRulesetIds.push("youtube_stealth");
  else disableRulesetIds.push("youtube_stealth");
  await chrome.declarativeNetRequest.updateEnabledRulesets({ enableRulesetIds, disableRulesetIds });
}

async function applyConfiguration(config, rebuildRules = true) {
  config.relay = normalizeRelayConfig(config.relay);
  config.adblock = normalizeAdblockConfig(config.adblock);
  config.privacy.cosmeticFiltering = config.adblock.cosmeticFiltering;
  config.privacy.annoyanceCleanup = config.adblock.antiAdblockCleanup;
  await saveConfig(config);
  await Promise.all([
    applyPrivacySettings(config),
    applyPermissionFirewall(config),
    registerContentGuards(config),
    updateRulesetState(config)
  ]);
  if (!config.adblock.enabled || !config.adblock.youtube.enabled) await clearAllYoutubeBypasses();
  if (rebuildRules) {
    const stored = await chrome.storage.local.get(["feedCache", "feedDomains", "threatDomains", "adDomains"]);
    const threats = new Set();
    const ads = new Set();
    const cache = stored.feedCache && typeof stored.feedCache === "object" ? stored.feedCache : {};

    if (config.security.knownThreats) {
      let usedThreatCache = false;
      for (const [key, cachedDomains] of Object.entries(cache)) {
        const source = FEEDS[key];
        const enabled = source?.kind === "threat" && (key === "hageziTif" ? config.feeds.hageziTif : config.feeds[key]);
        if (!enabled || !Array.isArray(cachedDomains)) continue;
        usedThreatCache = true;
        for (const domain of cachedDomains) {
          const normalized = normalizeDomain(domain);
          if (normalized) threats.add(normalized);
        }
      }
      if (!usedThreatCache) {
        for (const domain of stored.threatDomains || stored.feedDomains || []) {
          const normalized = normalizeDomain(domain);
          if (normalized) threats.add(normalized);
        }
      }
    }

    if (config.adblock.enabled && config.adblock.hageziAds) {
      const cachedAds = cache.hageziAds;
      if (Array.isArray(cachedAds)) {
        for (const domain of cachedAds) {
          const normalized = normalizeDomain(domain);
          if (normalized) ads.add(normalized);
        }
      } else {
        for (const domain of stored.adDomains || []) {
          const normalized = normalizeDomain(domain);
          if (normalized) ads.add(normalized);
        }
      }
    }

    for (const domain of config.customBlocklist.map(normalizeDomain).filter(Boolean)) threats.add(domain);
    for (const domain of config.allowlist.map(normalizeDomain).filter(Boolean)) threats.delete(domain);
    threatSetCache = threats;
    config.stats.domainsLoaded = threats.size;
    config.stats.adDomainsLoaded = config.adblock.enabled ? ads.size : 0;
    await chrome.storage.local.set({ threatDomains: Array.from(threats), adDomains: Array.from(ads) });
    await installDynamicRules(threats, ads, config);
  }
  await applyRelayConfiguration(config, false);
  await saveConfig(config);
  await Promise.all([scheduleFeedUpdates(config), scheduleRelayBenchmarks(config)]);
  await updateBadgeForAllTabs();
  return config;
}

async function scheduleFeedUpdates(config) {
  await chrome.alarms.clear("aegis-feed-update");
  const hours = Math.min(168, Math.max(1, Number(config.feeds.updateHours || 6)));
  await chrome.alarms.create("aegis-feed-update", { delayInMinutes: 2, periodInMinutes: hours * 60 });
}

async function scheduleRelayBenchmarks(config) {
  await chrome.alarms.clear("aegis-relay-benchmark");
  if (!config.relay.enabled || config.relay.strategy !== "smart" || config.relay.endpoints.filter(endpoint => endpoint.enabled).length < 2) return;
  const hours = Math.min(168, Math.max(1, Number(config.relay.autoBenchmarkHours || 12)));
  await chrome.alarms.create("aegis-relay-benchmark", { delayInMinutes: 10, periodInMinutes: hours * 60 });
}

async function setBadge(tabId, text, danger = false) {
  await chrome.action.setBadgeText({ tabId, text });
  await chrome.action.setBadgeBackgroundColor({ tabId, color: danger ? "#b91c1c" : "#334155" });
}

async function updateBadgeForAllTabs() {
  const config = await getConfig();
  const tabs = await chrome.tabs.query({});
  const text = config.relay.enabled && ["connected", "active"].includes(config.relay.status)
    ? "RLY"
    : config.enabled
      ? "ON"
      : config.adblock?.enabled
        ? "ADS"
        : "OFF";
  const danger = config.relay.enabled && ["blocked", "error"].includes(config.relay.status);
  await Promise.allSettled(tabs.map(tab => setBadge(tab.id, text, danger)));
}

async function handleProxyFailure(details) {
  if (relayBenchmarkInFlight) return;
  const config = await getConfig();
  if (!config.relay.enabled) return;
  config.relay = normalizeRelayConfig(config.relay);
  config.stats.relayFailures += 1;
  const current = config.relay.endpoints.find(endpoint => endpoint.id === config.relay.activeEndpointId);
  const proxyError = String(details?.error || details?.details || "Proxy error").slice(0, 300);
  if (current) current.lastError = proxyError;

  // Non-fatal errors can be site-specific. Record them without route flapping.
  if (details?.fatal === false) {
    await saveConfig(config);
    return;
  }

  const now = Date.now();
  if (now - lastProxyFailoverAt < 15000) {
    await saveConfig(config);
    return;
  }
  lastProxyFailoverAt = now;
  const alternatives = config.relay.endpoints
    .filter(endpoint => endpoint.enabled && endpoint.id !== config.relay.activeEndpointId)
    .sort((a, b) => (a.lastLatencyMs ?? Number.MAX_SAFE_INTEGER) - (b.lastLatencyMs ?? Number.MAX_SAFE_INTEGER));

  for (const candidate of alternatives) {
    try {
      const latency = await benchmarkOneRelay(candidate, config.relay);
      candidate.lastLatencyMs = latency;
      candidate.lastOk = Date.now();
      candidate.lastError = "";
      config.relay.activeEndpointId = candidate.id;
      config.relay.activeLabel = candidate.name;
      config.relay.status = "connected";
      config.relay.lastError = "";
      config.stats.relaySwitches += 1;
      await saveConfig(config);
      await updateBadgeForAllTabs();
      await chrome.notifications.create(`relay-failover-${now}`, {
        type: "basic",
        iconUrl: "assets/icons/icon128.png",
        title: "Secure relay failover",
        message: `Aegis verified and moved browser traffic to ${candidate.name} (${latency} ms).`
      });
      return;
    } catch (error) {
      candidate.lastLatencyMs = null;
      candidate.lastError = error.name === "AbortError" ? "Timed out" : error.message;
    }
  }

  config.relay.status = config.relay.failClosed ? "blocked" : "error";
  config.relay.lastError = proxyError;
  if (config.relay.failClosed) {
    // Keep the final proxy-only PAC route in place, preventing silent DIRECT fallback.
  } else {
    config.relay.enabled = false;
    await clearRelayProxy();
  }
  await saveConfig(config);
  await updateBadgeForAllTabs();
  await chrome.notifications.create(`relay-down-${now}`, {
    type: "basic",
    iconUrl: "assets/icons/icon128.png",
    title: config.relay.failClosed ? "Relay down: traffic held" : "Relay down: direct connection restored",
    message: config.relay.failClosed
      ? "No healthy fallback relay passed a connectivity probe. Fail-closed mode is preventing a silent direct-IP fallback."
      : "No healthy fallback relay passed a connectivity probe. Fail-closed was disabled, so the browser returned to its normal connection."
  });
}


function youtubeBypassRuleId(tabId) {
  const numeric = Number(tabId);
  if (!Number.isInteger(numeric) || numeric < 0) throw new Error("Invalid tab for YouTube bypass");
  return YOUTUBE_BYPASS_RULE_BASE + (numeric % 100000000);
}

async function setYoutubeTabBypass(tabId, enabled) {
  const ruleId = youtubeBypassRuleId(tabId);
  const removeRuleIds = [ruleId];
  const addRules = enabled ? [{
    id: ruleId,
    priority: 900,
    action: { type: "allow" },
    condition: {
      tabIds: [tabId],
      initiatorDomains: YOUTUBE_INITIATORS,
      resourceTypes: SAFE_RESOURCE_TYPES
    }
  }] : [];
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds, addRules });
  const key = `youtubeBypass:${tabId}`;
  if (enabled) await chrome.storage.session.set({ [key]: Date.now() });
  else await chrome.storage.session.remove(key);
}

async function isYoutubeTabBypassed(tabId) {
  if (tabId == null) return false;
  const key = `youtubeBypass:${tabId}`;
  const stored = await chrome.storage.session.get([key]);
  return Boolean(stored[key]);
}

async function clearAllYoutubeBypasses() {
  const rules = await chrome.declarativeNetRequest.getSessionRules();
  const removeRuleIds = rules.filter(rule => rule.id >= YOUTUBE_BYPASS_RULE_BASE).map(rule => rule.id);
  if (removeRuleIds.length) await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds, addRules: [] });
  const stored = await chrome.storage.session.get(null);
  const keys = Object.keys(stored).filter(key => key.startsWith("youtubeBypass:"));
  if (keys.length) await chrome.storage.session.remove(keys);
}

async function initialize() {
  let config = await getConfig(true);
  await saveConfig(config);
  await applyConfiguration(config, false);
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({ id: "aegis-scan-link", title: "Inspect link with Aegis GX", contexts: ["link"] });
  chrome.contextMenus.create({ id: "aegis-trust-site", title: "Trust this site in Aegis GX", contexts: ["page"] });
  const stored = await chrome.storage.local.get(["threatDomains", "adDomains"]);
  if (!stored.threatDomains?.length && !stored.adDomains?.length) updateThreatFeeds("initial-install").catch(console.error);
  else {
    threatSetCache = new Set((stored.threatDomains || []).map(normalizeDomain).filter(Boolean));
    const adSet = new Set((stored.adDomains || []).map(normalizeDomain).filter(Boolean));
    await installDynamicRules(threatSetCache, adSet, config);
    await saveConfig(config);
  }
}

chrome.runtime.onInstalled.addListener(() => initialize().catch(console.error));
chrome.runtime.onStartup.addListener(() => initialize().catch(console.error));
chrome.tabs.onRemoved.addListener(tabId => setYoutubeTabBypass(tabId, false).catch(() => {}));
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === "aegis-feed-update") updateThreatFeeds("scheduled").catch(console.error);
  if (alarm.name === "aegis-relay-benchmark") {
    chrome.idle.queryState(60).then(state => {
      if (state !== "active") benchmarkRelays("scheduled-idle", true).catch(console.error);
    }).catch(console.error);
  }
});
chrome.webNavigation.onBeforeNavigate.addListener(details => checkNavigation(details).catch(console.error));

chrome.commands.onCommand.addListener(async command => {
  if (command !== "toggle-protection") return;
  const config = await getConfig();
  config.enabled = !config.enabled;
  await applyConfiguration(config);
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === "aegis-scan-link" && info.linkUrl) {
    const analysis = analyzeUrl(info.linkUrl);
    const threats = await getThreatSet();
    analysis.knownThreat = threats.has(analysis.hostname) || Array.from(parentDomains(analysis.hostname)).some(domain => threats.has(domain));
    if (analysis.knownThreat) {
      analysis.score = 100;
      analysis.reasons.unshift("Domain appears in an enabled threat intelligence feed");
    }
    const report = new URL(chrome.runtime.getURL("warning/warning.html"));
    report.searchParams.set("target", info.linkUrl);
    report.searchParams.set("score", String(analysis.score));
    report.searchParams.set("host", analysis.hostname);
    report.searchParams.set("source", "manual-scan");
    report.searchParams.set("report", "1");
    report.searchParams.set("reasons", JSON.stringify(analysis.reasons));
    await chrome.tabs.create({ url: report.toString(), index: (tab?.index ?? 0) + 1 });
  }
  if (info.menuItemId === "aegis-trust-site" && tab?.url) {
    const host = normalizeDomain(new URL(tab.url).hostname);
    if (!host) return;
    const config = await getConfig();
    config.allowlist = Array.from(new Set([...config.allowlist, host]));
    threatSetCache?.delete(host);
    await applyConfiguration(config);
    await chrome.tabs.reload(tab.id);
  }
});

chrome.downloads.onChanged.addListener(async delta => {
  if (!delta.danger?.current) return;
  const config = await getConfig();
  if (!config.enabled) return;
  const danger = delta.danger.current;
  if (DANGEROUS_DOWNLOAD_TYPES.has(danger) && config.security.dangerousDownloadAction === "cancel") {
    const originHost = await allowlistedDownloadHost(delta.id);
    if (isAllowlistedHost(config, originHost)) return; // trusted site: user's call
    try { await chrome.downloads.cancel(delta.id); } catch { /* already stopped */ }
    config.stats.dangerousDownloadsStopped += 1;
    await saveConfig(config);
    await chrome.notifications.create(`download-${delta.id}`, {
      type: "basic",
      iconUrl: "assets/icons/icon128.png",
      title: "Dangerous download stopped",
      message: `Opera/Chromium classified this download as “${danger}”. Aegis cancelled it.`
    });
  } else if (DANGEROUS_DOWNLOAD_TYPES.has(danger) && config.security.dangerousDownloadAction === "warn") {
    await chrome.notifications.create(`download-${delta.id}`, {
      type: "basic",
      iconUrl: "assets/icons/icon128.png",
      title: "Dangerous download warning",
      message: `The browser classified this download as “${danger}”. Do not open it unless independently verified.`
    });
  } else if (SUSPICIOUS_DOWNLOAD_TYPES.has(danger) && config.security.suspiciousDownloadAction === "warn") {
    await chrome.notifications.create(`download-${delta.id}`, {
      type: "basic",
      iconUrl: "assets/icons/icon128.png",
      title: "Suspicious download",
      message: `The browser classified this download as “${danger}”. Review it before opening.`
    });
  }
});

if (chrome.proxy?.onProxyError) {
  chrome.proxy.onProxyError.addListener(details => handleProxyFailure(details).catch(console.error));
}

if (chrome.webRequest?.onAuthRequired) {
  chrome.webRequest.onAuthRequired.addListener((details, callback) => {
    (async () => {
      if (!details.isProxy) return callback({});
      const config = await getConfig();
      const endpoint = normalizeRelayConfig(config.relay).endpoints.find(item => item.id === config.relay.activeEndpointId);
      if (!endpoint || endpoint.scheme.startsWith("socks")) return callback({});
      const challengerHost = String(details.challenger?.host || "").toLowerCase().replace(/^\[|\]$/g, "");
      const challengerPort = Number(details.challenger?.port || 0);
      if (challengerHost && challengerHost !== endpoint.host) return callback({ cancel: true });
      if (challengerPort && challengerPort !== endpoint.port) return callback({ cancel: true });
      const attemptKey = `${details.requestId}:${endpoint.id}`;
      const attempts = (proxyAuthAttempts.get(attemptKey) || 0) + 1;
      proxyAuthAttempts.set(attemptKey, attempts);
      setTimeout(() => proxyAuthAttempts.delete(attemptKey), 60000);
      if (attempts > 2) return callback({ cancel: true });
      const stored = await chrome.storage.session.get([`relayCredential:${endpoint.id}`]);
      const credential = stored[`relayCredential:${endpoint.id}`];
      if (!credential?.password) return callback({});
      callback({ authCredentials: { username: credential.username || endpoint.username || "", password: credential.password } });
    })().catch(() => callback({}));
  }, { urls: ["<all_urls>"] }, ["asyncBlocking"]);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    switch (message?.type) {
      case "GET_STATE": {
        const config = await getConfig();
        let tab = null;
        if (message.tabId != null) {
          try { tab = await chrome.tabs.get(message.tabId); } catch { /* closed */ }
        }
        let host = "";
        try { host = tab?.url ? normalizeDomain(new URL(tab.url).hostname) : ""; } catch { /* ignored */ }
        const riskData = message.tabId != null ? await chrome.storage.session.get([`risk:${message.tabId}`]) : {};
        let proxyControl = { available: false, levelOfControl: "not_controllable", value: null };
        try { proxyControl = await proxyControlState(); } catch { /* unsupported browser surface */ }
        const youtubeBypassed = message.tabId != null ? await isYoutubeTabBypassed(message.tabId) : false;
        sendResponse({ config, host, risk: riskData[`risk:${message.tabId}`] || null, proxyControl, youtubeBypassed });
        break;
      }
      case "GET_MATCHED_RULES": {
        // The browser keeps roughly the last five minutes of matches and only
        // hands them over with declarativeNetRequestFeedback. onRuleMatchedDebug
        // would be richer but never fires for a packed install, so this is the
        // version that still works once Aegis ships as a .crx.
        let matched = [];
        let error = "";
        try {
          const result = await chrome.declarativeNetRequest.getMatchedRules({});
          matched = result?.rulesMatchedInfo || [];
        } catch (failure) {
          error = failure?.message || String(failure);
        }
        const tabTitles = new Map();
        const rows = [];
        for (const info of matched.slice(-300).reverse()) {
          const tabId = info.tabId;
          if (tabId != null && tabId >= 0 && !tabTitles.has(tabId)) {
            try {
              const tab = await chrome.tabs.get(tabId);
              tabTitles.set(tabId, tab?.url ? normalizeDomain(new URL(tab.url).hostname) : "");
            } catch { tabTitles.set(tabId, ""); }
          }
          rows.push({
            ruleId: info.rule?.ruleId,
            ruleset: info.rule?.rulesetId || "dynamic",
            tabId,
            host: tabTitles.get(tabId) || "",
            at: info.timeStamp
          });
        }
        sendResponse({ ok: !error, error, rules: rows });
        break;
      }
      case "SET_ENABLED": {
        const config = await getConfig();
        config.enabled = Boolean(message.enabled);
        await applyConfiguration(config);
        sendResponse({ ok: true, config });
        break;
      }
      case "SET_ADBLOCK_ENABLED": {
        const config = await getConfig();
        config.adblock.enabled = Boolean(message.enabled);
        await applyConfiguration(config);
        if (config.adblock.enabled && config.adblock.hageziAds) await updateThreatFeeds("adblock-toggle");
        sendResponse({ ok: true, config: await getConfig(true) });
        break;
      }
      case "SET_YOUTUBE_ADBLOCK": {
        const config = await getConfig();
        config.adblock.youtube.enabled = Boolean(message.enabled);
        if (message.mode) config.adblock.youtube.mode = message.mode;
        await applyConfiguration(config, false);
        sendResponse({ ok: true, config });
        break;
      }
      case "SET_PROFILE": {
        const config = await getConfig();
        config.profile = ["balanced", "hardened", "lockdown"].includes(message.profile) ? message.profile : "hardened";
        if (config.profile === "balanced") {
          config.security.heuristicThreshold = 70;
          config.privacy.disableReferrers = false;
          config.privacy.disablePageSpeculation = false;
          config.privacy.disableSearchSuggestions = false;
          config.privacy.blockNotifications = false;
          config.privacy.blockGeolocation = false;
          config.privacy.blockCamera = false;
          config.privacy.blockMicrophone = false;
          config.privacy.protectWebRTC = true;
        } else if (config.profile === "hardened") {
          config.security.heuristicThreshold = 55;
          config.privacy.disableReferrers = false;
          config.privacy.disablePageSpeculation = false;
          config.privacy.disableSearchSuggestions = false;
          config.privacy.blockNotifications = true;
          config.privacy.blockGeolocation = false;
          config.privacy.blockCamera = false;
          config.privacy.blockMicrophone = false;
          config.privacy.protectWebRTC = true;
        } else {
          config.security.heuristicThreshold = 40;
          config.privacy.disableReferrers = true;
          config.privacy.disablePageSpeculation = true;
          config.privacy.disableSearchSuggestions = true;
          config.privacy.blockNotifications = true;
          config.privacy.blockGeolocation = true;
          config.privacy.blockCamera = true;
          config.privacy.blockMicrophone = true;
          config.privacy.protectWebRTC = true;
        }
        await applyConfiguration(config);
        sendResponse({ ok: true, config });
        break;
      }
      case "UPDATE_CONFIG": {
        const previous = structuredClone(await getConfig());
        const config = mergeDeep(previous, message.patch || {});
        await applyConfiguration(config);
        const needsAdFeed = config.adblock?.enabled && config.adblock?.hageziAds
          && (!previous.adblock?.enabled || !previous.adblock?.hageziAds || !config.stats.adDomainsLoaded);
        const needsThreatFeed = config.enabled && config.security?.knownThreats
          && ((!previous.enabled || !previous.security?.knownThreats) || !config.stats.domainsLoaded);
        if (needsAdFeed || needsThreatFeed) await updateThreatFeeds("settings-change");
        sendResponse({ ok: true, config: await getConfig(true) });
        break;
      }
      case "RELAY_CONNECT": {
        const config = await getConfig();
        config.relay = normalizeRelayConfig(config.relay);
        if (message.endpointId && config.relay.endpoints.some(endpoint => endpoint.id === message.endpointId && endpoint.enabled)) {
          config.relay.activeEndpointId = message.endpointId;
        }
        const endpoint = selectedRelayEndpoint(config.relay);
        if (!endpoint) throw new Error("Add at least one trusted relay endpoint first.");
        config.relay.enabled = true;
        await applyConfiguration(config, false);
        try {
          const latency = await benchmarkOneRelay(endpoint, config.relay);
          endpoint.lastLatencyMs = latency;
          endpoint.lastOk = Date.now();
          endpoint.lastError = "";
          config.relay.status = "connected";
          config.relay.activeLabel = endpoint.name;
          config.relay.lastError = "";
          config.stats.relaySwitches += 1;
        } catch (error) {
          endpoint.lastLatencyMs = null;
          endpoint.lastError = error.name === "AbortError" ? "Timed out" : error.message;
          config.relay.lastError = endpoint.lastError;
          config.stats.relayFailures += 1;
          if (config.relay.failClosed) {
            config.relay.status = "blocked";
          } else {
            config.relay.enabled = false;
            config.relay.status = "error";
            await clearRelayProxy();
          }
        }
        await applyPrivacySettings(config);
        await saveConfig(config);
        await updateBadgeForAllTabs();
        sendResponse({ ok: config.relay.status === "connected", config, relay: config.relay });
        break;
      }
      case "RELAY_DISCONNECT": {
        const config = await getConfig();
        config.relay.enabled = false;
        await applyConfiguration(config, false);
        sendResponse({ ok: true, config, relay: config.relay });
        break;
      }
      case "RELAY_BENCHMARK": {
        sendResponse(await benchmarkRelays("manual", true));
        break;
      }
      case "SET_RELAY_CREDENTIAL": {
        sendResponse({ ok: true, ...(await loadRelayCredential(message.endpointId, message.username, message.password)) });
        break;
      }
      case "GET_RELAY_CREDENTIAL_STATUS": {
        const id = String(message.endpointId || "");
        const stored = id ? await chrome.storage.session.get([`relayCredential:${id}`]) : {};
        sendResponse({ ok: true, stored: Boolean(stored[`relayCredential:${id}`]?.password) });
        break;
      }
      case "CHECK_PUBLIC_IP": {
        sendResponse(await checkObservedPublicIps());
        break;
      }
      case "PANIC_WIPE": {
        sendResponse(await panicWipe(message.hours));
        break;
      }
      case "OPEN_OPERA_VPN_SETTINGS": {
        try {
          await chrome.tabs.create({ url: "opera://settings/?search=vpn" });
          sendResponse({ ok: true });
        } catch (error) {
          sendResponse({ ok: false, error: error.message, manual: "opera://settings/?search=vpn" });
        }
        break;
      }
      case "UPDATE_FEEDS": {
        sendResponse(await updateThreatFeeds("manual"));
        break;
      }
      case "RESET_CONFIG": {
        configCache = structuredClone(DEFAULTS);
        threatSetCache = new Set();
        await chrome.storage.local.remove(["config", "feedCache", "feedDomains", "threatDomains", "adDomains", "feedMetadata"]);
        await chrome.storage.session.clear();
        await clearAllYoutubeBypasses();
        await clearRelayProxy();
        await applyConfiguration(configCache, true);
        const result = await updateThreatFeeds("reset");
        sendResponse({ ok: true, config: await getConfig(true), feedResult: result });
        break;
      }
      case "TOGGLE_ADBLOCK_SITE": {
        const domain = normalizeDomain(message.domain);
        const config = await getConfig();
        if (!domain) throw new Error("Invalid domain");
        const set = new Set(config.adblock.allowlist.map(normalizeDomain).filter(Boolean));
        if (set.has(domain)) set.delete(domain); else set.add(domain);
        config.adblock.allowlist = Array.from(set).sort();
        await applyConfiguration(config);
        sendResponse({ ok: true, allowed: set.has(domain), config });
        break;
      }
      case "YOUTUBE_ANTI_ADBLOCK_DETECTED": {
        const config = await getConfig();
        config.adblock.youtube.lastDetection = Date.now();
        config.adblock.youtube.detectionCount += 1;
        config.stats.antiAdblockDetections += 1;
        let bypassed = false;
        if (sender.tab?.id != null && config.adblock.youtube.autoFallback) {
          await setYoutubeTabBypass(sender.tab.id, true);
          bypassed = true;
        }
        await saveConfig(config);
        sendResponse({ ok: true, bypassed, reload: bypassed });
        break;
      }
      case "CLEAR_YOUTUBE_BYPASS": {
        if (message.tabId == null) throw new Error("Invalid tab");
        await setYoutubeTabBypass(message.tabId, false);
        sendResponse({ ok: true });
        break;
      }
      case "YOUTUBE_AD_HANDLED": {
        const config = await getConfig();
        config.stats.youtubeAdsHandled += Math.max(1, Math.min(25, Number(message.count || 1)));
        await saveConfig(config);
        sendResponse({ ok: true });
        break;
      }
      case "TOGGLE_SITE": {
        const domain = normalizeDomain(message.domain);
        const config = await getConfig();
        if (!domain) throw new Error("Invalid domain");
        const set = new Set(config.allowlist.map(normalizeDomain).filter(Boolean));
        if (set.has(domain)) set.delete(domain); else set.add(domain);
        config.allowlist = Array.from(set).sort();
        threatSetCache = null;
        await applyConfiguration(config);
        sendResponse({ ok: true, allowed: set.has(domain), config });
        break;
      }
      case "PROCEED_ONCE": {
        const host = normalizeDomain(message.hostname);
        if (!host || message.tabId == null) throw new Error("Invalid bypass request");
        await chrome.storage.session.set({ [`bypass:${message.tabId}:${host}`]: Date.now() + 10 * 60 * 1000 });
        await chrome.tabs.update(message.tabId, { url: message.target });
        sendResponse({ ok: true });
        break;
      }
      case "TRUST_DOMAIN": {
        const host = normalizeDomain(message.hostname);
        const config = await getConfig();
        if (!host) throw new Error("Invalid domain");
        config.allowlist = Array.from(new Set([...config.allowlist, host])).sort();
        threatSetCache = null;
        await applyConfiguration(config);
        if (message.tabId != null && message.target) await chrome.tabs.update(message.tabId, { url: message.target });
        sendResponse({ ok: true });
        break;
      }
      case "CONTENT_STATS": {
        if (sender.tab?.id != null && message.blocked > 0) {
          const text = message.blocked > 99 ? "99+" : String(message.blocked);
          await setBadge(sender.tab.id, text, false);
        }
        sendResponse({ ok: true });
        break;
      }
      case "GET_MATCHED_COUNT": {
        let count = 0;
        try {
          const result = await chrome.declarativeNetRequest.getMatchedRules({ tabId: message.tabId, minTimeStamp: Date.now() - 30 * 60 * 1000 });
          count = result.rulesMatchedInfo.length;
        } catch { /* activeTab grant or browser support may differ */ }
        sendResponse({ count });
        break;
      }
      default:
        sendResponse({ ok: false, error: "Unknown message" });
    }
  })().catch(error => sendResponse({ ok: false, error: error.message }));
  return true;
});

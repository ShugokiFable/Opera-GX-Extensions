const $ = id => document.getElementById(id);
let config = null;
let proxyControl = null;

const privacyKeys = [
  "stripTrackingParams", "globalPrivacyControl", "doNotTrack", "disableHyperlinkAuditing",
  "disableNetworkPrediction", "disablePageSpeculation", "protectWebRTC", "disableReferrers",
  "blockThirdPartyCookies", "disablePrivacySandbox", "disableSearchSuggestions",
  "blockLocalNetworkProbing", "blockNotifications", "blockGeolocation", "blockCamera",
  "blockMicrophone", "blockAutomaticDownloads", "popupGuard"
];
const securityKeys = ["knownThreats", "heuristicWarnings"];
const proxySchemes = new Set(["http", "https", "socks4", "socks5"]);

function fmt(n) { return new Intl.NumberFormat().format(n || 0); }
function lines(value) { return value.split(/\r?\n/).map(x => x.trim()).filter(Boolean); }
function age(ts) {
  if (!ts) return "Never";
  const h = Math.floor((Date.now() - ts) / 3600000);
  return h < 1 ? "< 1 hour" : h < 48 ? `${h} hours` : `${Math.floor(h / 24)} days`;
}
function detectionAge(ts) {
  if (!ts) return "No YouTube anti-adblock detection recorded.";
  return `Last YouTube anti-adblock detection: ${age(ts)} ago.`;
}

function syncYouTubeModeUi() {
  const enabled = $("youtubeEnabled").checked && $("adblockEnabled").checked;
  $("youtubeMode").disabled = !enabled;
  $("youtubeHidePromotions").disabled = !enabled;
  $("youtubeAutoFallback").disabled = !enabled || $("youtubeMode").value === "network";
}
function setStatus(text, error = false) {
  $("saveStatus").textContent = text;
  $("saveStatus").style.color = error ? "#f87171" : "#edf4ff";
}
function relayKey(endpoint) { return `${endpoint.scheme}|${endpoint.host}|${endpoint.port}`; }
function makeEndpointId(endpoint, index = 0) {
  const raw = `${endpoint?.scheme || ""}|${endpoint?.host || ""}|${endpoint?.port || ""}|${index}`;
  let hash = 2166136261;
  for (let i = 0; i < raw.length; i += 1) {
    hash ^= raw.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `relay-${(hash >>> 0).toString(36)}`;
}

function parseRelayEndpoints(value) {
  const existing = new Map((config?.relay?.endpoints || []).map(endpoint => [relayKey(endpoint), endpoint]));
  const parsed = [];
  const errors = [];
  for (const [index, raw] of lines(value).entries()) {
    const parts = raw.split("|").map(part => part.trim());
    if (parts.length < 4) {
      errors.push(`Line ${index + 1}: expected Name | scheme | host | port`);
      continue;
    }
    const [name, rawScheme, host, rawPort, username = ""] = parts;
    const scheme = rawScheme.toLowerCase();
    const port = Number(rawPort);
    if (!proxySchemes.has(scheme) || !host || !Number.isInteger(port) || port < 1 || port > 65535) {
      errors.push(`Line ${index + 1}: invalid scheme, host, or port`);
      continue;
    }
    const key = `${scheme}|${host.toLowerCase()}|${port}`;
    const previous = existing.get(key) || {};
    parsed.push({
      ...previous,
      id: previous.id || makeEndpointId({ scheme, host: host.toLowerCase(), port }, index),
      name: name || host,
      scheme,
      host: host.toLowerCase(),
      port,
      username,
      enabled: previous.enabled !== false
    });
  }
  return { endpoints: parsed.slice(0, 12), errors };
}

function endpointsToText(endpoints) {
  return (endpoints || []).map(endpoint => [
    endpoint.name,
    endpoint.scheme,
    endpoint.host,
    endpoint.port,
    endpoint.username || ""
  ].join(" | ").replace(/\s+\|\s*$/, "")).join("\n");
}

function populateEndpointSelect(select, endpoints, selectedId, emptyLabel = "No endpoint configured") {
  select.textContent = "";
  if (!endpoints.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = emptyLabel;
    select.appendChild(option);
    return;
  }
  for (const endpoint of endpoints) {
    const option = document.createElement("option");
    option.value = endpoint.id;
    const latency = Number.isFinite(endpoint.lastLatencyMs) ? ` · ${endpoint.lastLatencyMs} ms` : "";
    option.textContent = `${endpoint.name} · ${endpoint.scheme.toUpperCase()} ${endpoint.host}:${endpoint.port}${latency}`;
    if (endpoint.id === selectedId) option.selected = true;
    select.appendChild(option);
  }
}

function relayStatusText(relay) {
  const control = proxyControl?.levelOfControl ? ` Proxy control: ${proxyControl.levelOfControl.replaceAll("_", " ")}.` : "";
  if (!relay.enabled) return `Relay is off.${control}`;
  if (relay.status === "connected") return `Connected and verified through ${relay.activeLabel}. Fail-closed is ${relay.failClosed ? "enabled" : "disabled"}.${control}`;
  if (relay.status === "active") return `Proxy route applied through ${relay.activeLabel}, but no recent connectivity benchmark is recorded. Fail-closed is ${relay.failClosed ? "enabled" : "disabled"}.${control}`;
  if (relay.status === "blocked") return `Traffic is being held because the relay is unavailable and fail-closed is enabled. ${relay.lastError || ""}${control}`;
  return `${relay.lastError || "Relay configuration error."}${control}`;
}

function renderRelayResults(results) {
  if (!results?.length) {
    $("relayResults").textContent = "No benchmark results yet.";
    return;
  }
  $("relayResults").textContent = results.map(result => result.ok
    ? `✓ ${result.name}: ${result.latencyMs} ms`
    : `✗ ${result.name}: ${result.error || "failed"}`
  ).join("\n");
}

function render() {
  $("domains").textContent = fmt(config.stats.domainsLoaded);
  $("adDomains").textContent = fmt(config.stats.adDomainsLoaded);
  $("rules").textContent = fmt(config.stats.dynamicRules);
  $("stopped").textContent = fmt(config.stats.threatsStopped + config.stats.dangerousDownloadsStopped);
  $("feedAge").textContent = age(config.stats.lastFeedUpdate);
  $("liveBadge").textContent = config.enabled ? "Shield online" : config.adblock.enabled ? "Ad shield only" : "Protection paused";
  $("relayMetric").textContent = config.relay.enabled ? config.relay.activeLabel : "Off";
  $("relayBadge").textContent = config.relay.status === "connected" ? "Verified" : config.relay.status === "active" ? "Active" : config.relay.status === "blocked" ? "Fail-closed" : config.relay.enabled ? "Error" : "Off";
  $("relayBadge").style.color = ["connected", "active"].includes(config.relay.status) ? "#5eead4" : ["blocked", "error"].includes(config.relay.status) ? "#f87171" : "#94a3b8";

  $("adblockEnabled").checked = config.adblock.enabled;
  $("hageziAds").checked = config.adblock.hageziAds;
  $("cosmeticFiltering").checked = config.adblock.cosmeticFiltering;
  $("annoyanceCleanup").checked = config.adblock.antiAdblockCleanup;
  $("sponsoredCleanup").checked = config.adblock.sponsoredCleanup;
  $("youtubeEnabled").checked = config.adblock.youtube.enabled;
  $("youtubeMode").value = config.adblock.youtube.mode;
  $("youtubeAutoFallback").checked = config.adblock.youtube.autoFallback;
  $("youtubeHidePromotions").checked = config.adblock.youtube.hidePromotions;
  $("adblockAllowlist").value = config.adblock.allowlist.join("\n");
  $("adshieldBadge").textContent = config.adblock.enabled ? "Network shield on" : "Off";
  $("adshieldBadge").style.color = config.adblock.enabled ? "#5eead4" : "#94a3b8";
  $("youtubeDetectionStatus").textContent = `${detectionAge(config.adblock.youtube.lastDetection)} Detections: ${fmt(config.adblock.youtube.detectionCount)} · Ads handled: ${fmt(config.stats.youtubeAdsHandled)}.`;
  syncYouTubeModeUi();

  const profile = document.querySelector(`input[name='profile'][value='${config.profile}']`);
  if (profile) profile.checked = true;
  for (const key of privacyKeys) $(key).checked = Boolean(config.privacy[key]);
  for (const key of securityKeys) $(key).checked = Boolean(config.security[key]);
  $("heuristicThreshold").value = config.security.heuristicThreshold;
  $("thresholdOut").value = config.security.heuristicThreshold;
  $("dangerousDownloadAction").value = config.security.dangerousDownloadAction;
  $("suspiciousDownloadAction").value = config.security.suspiciousDownloadAction;
  $("hagezi").checked = config.feeds.hageziTif;
  $("urlhaus").checked = config.feeds.urlhaus;
  $("updateHours").value = config.feeds.updateHours;
  $("allowlist").value = config.allowlist.join("\n");
  $("customBlocklist").value = config.customBlocklist.join("\n");
  $("feedError").textContent = config.stats.lastFeedError || "";

  $("relayEnabled").checked = config.relay.enabled;
  $("relayFailClosed").checked = config.relay.failClosed;
  $("relayBypassLocal").checked = config.relay.bypassLocal;
  $("relayStrategy").value = config.relay.strategy;
  $("relayAutoBenchmarkHours").value = config.relay.autoBenchmarkHours;
  $("relayEndpoints").value = endpointsToText(config.relay.endpoints);
  populateEndpointSelect($("relayActiveEndpoint"), config.relay.endpoints, config.relay.activeEndpointId);
  populateEndpointSelect($("credentialEndpoint"), config.relay.endpoints, config.relay.activeEndpointId);
  $("relayStatus").textContent = relayStatusText(config.relay);
  $("publicIp").textContent = config.relay.publicIp || "Not checked";
  updateCredentialUi().catch(error => {
    $("credentialStatus").textContent = `Credential status unavailable: ${error.message}`;
  });
}

async function load() {
  const response = await chrome.runtime.sendMessage({ type: "GET_STATE" });
  if (!response?.config) throw new Error(response?.error || "Unable to load extension state.");
  config = response.config;
  proxyControl = response.proxyControl;
  render();
  renderRelayResults(null);
}

function gather() {
  const parsedRelays = parseRelayEndpoints($("relayEndpoints").value);
  if (parsedRelays.errors.length) throw new Error(parsedRelays.errors.join(" · "));
  const patch = {
    profile: document.querySelector("input[name='profile']:checked").value,
    privacy: {},
    security: {},
    feeds: {},
    adblock: {
      enabled: $("adblockEnabled").checked,
      hageziAds: $("hageziAds").checked,
      cosmeticFiltering: $("cosmeticFiltering").checked,
      antiAdblockCleanup: $("annoyanceCleanup").checked,
      sponsoredCleanup: $("sponsoredCleanup").checked,
      allowlist: lines($("adblockAllowlist").value),
      youtube: {
        enabled: $("youtubeEnabled").checked,
        mode: $("youtubeMode").value,
        autoFallback: $("youtubeAutoFallback").checked,
        hidePromotions: $("youtubeHidePromotions").checked
      }
    },
    relay: {
      enabled: $("relayEnabled").checked,
      strategy: $("relayStrategy").value,
      activeEndpointId: $("relayActiveEndpoint").value,
      failClosed: $("relayFailClosed").checked,
      bypassLocal: $("relayBypassLocal").checked,
      autoBenchmarkHours: Number($("relayAutoBenchmarkHours").value),
      endpoints: parsedRelays.endpoints
    },
    allowlist: lines($("allowlist").value),
    customBlocklist: lines($("customBlocklist").value)
  };
  for (const key of privacyKeys) patch.privacy[key] = $(key).checked;
  for (const key of securityKeys) patch.security[key] = $(key).checked;
  patch.security.heuristicThreshold = Number($("heuristicThreshold").value);
  patch.security.dangerousDownloadAction = $("dangerousDownloadAction").value;
  patch.security.suspiciousDownloadAction = $("suspiciousDownloadAction").value;
  patch.feeds.hageziTif = $("hagezi").checked;
  patch.feeds.urlhaus = $("urlhaus").checked;
  patch.feeds.updateHours = Number($("updateHours").value);
  return patch;
}

async function saveCurrent(statusText = "Applying settings and compiling filters…") {
  setStatus(statusText);
  const response = await chrome.runtime.sendMessage({ type: "UPDATE_CONFIG", patch: gather() });
  if (!response?.ok) throw new Error(response?.error || "Settings could not be applied.");
  config = response.config;
  const state = await chrome.runtime.sendMessage({ type: "GET_STATE" });
  config = state.config;
  proxyControl = state.proxyControl;
  render();
  return config;
}

async function updateCredentialUi() {
  const endpoint = config?.relay?.endpoints?.find(item => item.id === $("credentialEndpoint").value);
  $("credentialUsername").value = endpoint?.username || "";
  $("credentialPassword").value = "";
  if (!endpoint) {
    $("credentialStatus").textContent = "";
    return;
  }
  const response = await chrome.runtime.sendMessage({ type: "GET_RELAY_CREDENTIAL_STATUS", endpointId: endpoint.id });
  $("credentialStatus").textContent = response?.stored ? "Credential loaded until Opera closes." : "No session password loaded.";
}

$("adblockEnabled").addEventListener("change", syncYouTubeModeUi);
$("youtubeEnabled").addEventListener("change", syncYouTubeModeUi);
$("youtubeMode").addEventListener("change", syncYouTubeModeUi);

$("heuristicThreshold").addEventListener("input", event => $("thresholdOut").value = event.target.value);

$("save").addEventListener("click", async () => {
  $("save").disabled = true;
  try {
    await saveCurrent();
    setStatus("Settings applied. New page loads use the updated shield.");
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    $("save").disabled = false;
  }
});

$("updateFeeds").addEventListener("click", async () => {
  $("updateFeeds").disabled = true;
  setStatus("Downloading and compiling live intelligence…");
  try {
    const result = await chrome.runtime.sendMessage({ type: "UPDATE_FEEDS" });
    setStatus(result.ok ? `Loaded ${fmt(result.domains)} threat domains and ${fmt(result.adDomains)} ad domains into ${fmt(result.rules)} batched rules.` : `Updated with warnings: ${result.errors.join(" | ")}`, !result.ok);
    await load();
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    $("updateFeeds").disabled = false;
  }
});

$("reset").addEventListener("click", async () => {
  if (!confirm("Reset all Aegis settings, relay endpoints, session credentials, and lists to defaults?")) return;
  setStatus("Resetting defaults and rebuilding intelligence…");
  const response = await chrome.runtime.sendMessage({ type: "RESET_CONFIG" });
  if (!response?.ok) return setStatus(response?.error || "Reset failed.", true);
  await load();
  setStatus("Defaults restored and intelligence rebuilt.");
});

document.querySelectorAll("input[name='profile']").forEach(radio => radio.addEventListener("change", async event => {
  const response = await chrome.runtime.sendMessage({ type: "SET_PROFILE", profile: event.target.value });
  if (!response?.ok) return setStatus(response?.error || "Profile change failed.", true);
  await load();
  setStatus("Profile applied.");
}));

$("relayEndpoints").addEventListener("change", () => {
  try {
    const { endpoints, errors } = parseRelayEndpoints($("relayEndpoints").value);
    if (errors.length) throw new Error(errors.join(" · "));
    const selected = $("relayActiveEndpoint").value;
    populateEndpointSelect($("relayActiveEndpoint"), endpoints, selected);
    populateEndpointSelect($("credentialEndpoint"), endpoints, selected);
  } catch (error) {
    setStatus(error.message, true);
  }
});

$("benchmarkRelay").addEventListener("click", async () => {
  $("benchmarkRelay").disabled = true;
  try {
    await saveCurrent("Saving endpoints before benchmark…");
    setStatus("Testing each relay and selecting the fastest healthy route…");
    const result = await chrome.runtime.sendMessage({ type: "RELAY_BENCHMARK" });
    renderRelayResults(result.results);
    if (!result.ok) throw new Error("Every relay failed. Direct fallback was not enabled automatically.");
    await load();
    setStatus(`Connected through ${result.activeLabel}.`);
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    $("benchmarkRelay").disabled = false;
  }
});

$("connectRelay").addEventListener("click", async () => {
  try {
    await saveCurrent("Saving relay configuration…");
    const response = await chrome.runtime.sendMessage({ type: "RELAY_CONNECT", endpointId: $("relayActiveEndpoint").value });
    if (!response?.ok) throw new Error(response?.relay?.lastError || response?.error || "Relay connection failed.");
    await load();
    setStatus(`Connected through ${response.relay.activeLabel}.`);
  } catch (error) {
    setStatus(error.message, true);
  }
});

$("disconnectRelay").addEventListener("click", async () => {
  const response = await chrome.runtime.sendMessage({ type: "RELAY_DISCONNECT" });
  if (!response?.ok) return setStatus(response?.error || "Relay disconnect failed.", true);
  await load();
  setStatus("Secure Relay disconnected. Opera is using its normal/system route.");
});

$("checkIp").addEventListener("click", async () => {
  $("checkIp").disabled = true;
  setStatus("Querying two independent public-IP observers. This occurs only on your click…");
  try {
    const result = await chrome.runtime.sendMessage({ type: "CHECK_PUBLIC_IP" });
    $("publicIp").textContent = result.observed?.join(", ") || "No address returned";
    const suffix = result.errors?.length ? ` Warnings: ${result.errors.join(" | ")}` : "";
    setStatus(`Observed public address${result.observed?.length === 1 ? "" : "es"}: ${result.observed?.join(", ") || "none"}.${suffix}`, !result.ok);
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    $("checkIp").disabled = false;
  }
});

$("credentialEndpoint").addEventListener("change", updateCredentialUi);
$("saveCredential").addEventListener("click", async () => {
  const endpointId = $("credentialEndpoint").value;
  const response = await chrome.runtime.sendMessage({
    type: "SET_RELAY_CREDENTIAL",
    endpointId,
    username: $("credentialUsername").value,
    password: $("credentialPassword").value
  });
  if (!response?.ok) return setStatus(response?.error || "Credential could not be loaded.", true);
  $("credentialPassword").value = "";
  await updateCredentialUi();
  setStatus(response.stored ? "Proxy credential loaded for this Opera session." : "Session credential removed.");
});

$("operaVpnSettings").addEventListener("click", async () => {
  const response = await chrome.runtime.sendMessage({ type: "OPEN_OPERA_VPN_SETTINGS" });
  if (!response?.ok) setStatus(`Opera blocked the internal settings link. Paste ${response.manual || "opera://settings/?search=vpn"} into the address bar.`, true);
});

$("panicWipe").addEventListener("click", async () => {
  const hours = Number($("panicHours").value);
  const label = hours === 0 ? "all normal browsing data" : `normal browsing data from the last ${hours} hour${hours === 1 ? "" : "s"}`;
  if (!confirm(`Clear ${label}? This signs you out of affected sites and cannot be undone.`)) return;
  $("panicWipe").disabled = true;
  setStatus("Clearing website cookies, cache, storage, history, service workers, and download history…");
  try {
    const response = await chrome.runtime.sendMessage({ type: "PANIC_WIPE", hours });
    if (!response?.ok) throw new Error(response?.error || "Cleanup failed.");
    setStatus("Panic cleanup completed. Aegis settings were preserved.");
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    $("panicWipe").disabled = false;
  }
});

function renderMatches(rules) {
  const list = $("matchList");
  list.textContent = "";
  if (!rules.length) {
    const empty = document.createElement("p");
    empty.className = "match-empty";
    empty.textContent = "No rule matched in the window the browser still remembers. Reload the page that broke, then refresh this.";
    list.appendChild(empty);
    return;
  }
  for (const entry of rules) {
    const row = document.createElement("div");
    row.className = "match-row";
    const when = entry.at ? new Date(entry.at).toLocaleTimeString() : "";
    const left = document.createElement("div");
    const strong = document.createElement("strong");
    strong.textContent = `${entry.ruleset} · rule ${entry.ruleId}`;
    const small = document.createElement("small");
    small.textContent = [entry.host || "unknown page", when].filter(Boolean).join(" · ");
    left.append(strong, small);
    const tag = document.createElement("span");
    tag.className = "match-tag";
    tag.textContent = entry.ruleset;
    row.append(left, tag);
    list.appendChild(row);
  }
}

$("refreshMatches").addEventListener("click", async () => {
  $("refreshMatches").disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({ type: "GET_MATCHED_RULES" });
    if (!response?.ok && response?.error) throw new Error(response.error);
    renderMatches(response?.rules || []);
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    $("refreshMatches").disabled = false;
  }
});

load().catch(error => setStatus(error.message, true));

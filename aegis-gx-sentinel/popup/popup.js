const $ = id => document.getElementById(id);
let tabId = null;
let currentHost = "";
let currentConfig = null;
let youtubeBypassed = false;

function fmt(value) { return new Intl.NumberFormat().format(value || 0); }
function setMessage(text, error = false) {
  $("message").textContent = text;
  $("message").style.color = error ? "#f87171" : "#92a1b7";
}
function relayStateLabel(relay) {
  if (!relay.enabled) return "OFF";
  if (["connected", "active"].includes(relay.status)) return "ROUTED";
  if (relay.status === "blocked") return "HELD";
  return "ERROR";
}
function renderRelay(relay) {
  $("relayName").textContent = relay.enabled ? relay.activeLabel : "Normal system route";
  $("relayState").textContent = relayStateLabel(relay);
  $("relayState").className = `badge ${relay.status || "off"}`;
  $("publicIp").textContent = `Observed IP: ${relay.publicIp || "not checked"}`;
  if (!relay.enabled) {
    $("relayDetail").textContent = relay.endpoints.length
      ? `${relay.endpoints.length} trusted endpoint${relay.endpoints.length === 1 ? "" : "s"} configured. Fail-closed is ${relay.failClosed ? "on" : "off"}.`
      : "No trusted relay endpoint is configured. This feature is a browser proxy, not a device-wide VPN.";
    $("relayAction").textContent = relay.endpoints.length ? (relay.strategy === "smart" && relay.endpoints.length > 1 ? "Connect fastest" : "Connect relay") : "Configure relay";
    return;
  }
  if (["connected", "active"].includes(relay.status)) {
    const endpoint = relay.endpoints.find(item => item.id === relay.activeEndpointId);
    const latency = Number.isFinite(endpoint?.lastLatencyMs) ? ` · ${endpoint.lastLatencyMs} ms` : "";
    const verified = relay.status === "connected" ? "verified" : "not recently benchmarked";
    $("relayDetail").textContent = `Browser route active${latency} (${verified}). WebRTC direct UDP protection is forced on.`;
    $("relayAction").textContent = "Disconnect relay";
  } else if (relay.status === "blocked") {
    $("relayDetail").textContent = relay.lastError || "Fail-closed mode is holding traffic to prevent direct-IP fallback.";
    $("relayAction").textContent = "Disconnect relay";
  } else {
    $("relayDetail").textContent = relay.lastError || "The configured relay could not be applied.";
    $("relayAction").textContent = "Disconnect relay";
  }
}

function domainMatches(host, domain) { return host === domain || host.endsWith(`.${domain}`); }
function isYoutubeHost(host) { return domainMatches(host, "youtube.com") || domainMatches(host, "youtube-nocookie.com"); }
function renderAdShield() {
  const adblock = currentConfig.adblock;
  $("adblockToggle").checked = adblock.enabled;
  const allowed = adblock.allowlist.some(domain => domainMatches(currentHost, domain));
  $("siteAdToggle").textContent = allowed ? "Block ads here" : "Allow ads here";
  $("siteAdToggle").disabled = !currentHost;
  $("adshieldName").textContent = adblock.enabled ? `${fmt(currentConfig.stats.adDomainsLoaded)} ad domains` : "Off";
  $("adshieldDetail").textContent = adblock.enabled
    ? `Network rules on · cosmetic cleanup ${adblock.cosmeticFiltering ? "on" : "off"}.`
    : "Ad blocking is independently disabled; threat protection can remain active.";
  const onYoutube = isYoutubeHost(currentHost);
  $("youtubeToggle").hidden = !onYoutube;
  if (onYoutube) {
    if (youtubeBypassed) $("youtubeToggle").textContent = "Resume YouTube filtering";
    else $("youtubeToggle").textContent = adblock.youtube.enabled ? `YouTube: ${adblock.youtube.mode}` : "Enable YouTube Shield";
  }
}

async function load() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id;
  const response = await chrome.runtime.sendMessage({ type: "GET_STATE", tabId });
  if (!response?.config) throw new Error(response?.error || "Unable to read Aegis state.");
  currentConfig = response.config;
  currentHost = response.host;
  youtubeBypassed = Boolean(response.youtubeBypassed);
  $("masterToggle").checked = currentConfig.enabled;
  $("profileSelect").value = currentConfig.profile;
  $("statusText").textContent = currentConfig.enabled ? "Shield online" : "Protection paused";
  if (currentConfig.relay.enabled && ["connected", "active"].includes(currentConfig.relay.status)) $("statusText").textContent += " · relay active";
  $("currentHost").textContent = currentHost || "Protected browser page";
  const score = response.risk?.score || 0;
  $("riskScore").textContent = score;
  $("riskScore").style.color = score >= 70 ? "#f87171" : score >= 35 ? "#fbbf24" : "#5eead4";
  $("domainCount").textContent = fmt(currentConfig.stats.domainsLoaded);
  $("ruleCount").textContent = fmt(currentConfig.stats.dynamicRules);
  $("stoppedCount").textContent = fmt(currentConfig.stats.threatsStopped + currentConfig.stats.dangerousDownloadsStopped);
  const allowed = currentConfig.allowlist.includes(currentHost);
  $("siteToggle").textContent = allowed ? "Protect this site" : "Trust this site";
  renderRelay(currentConfig.relay);
  renderAdShield();
  if (tabId != null) {
    const matched = await chrome.runtime.sendMessage({ type: "GET_MATCHED_COUNT", tabId });
    if (matched.count) $("statusText").textContent += ` · ${matched.count} request${matched.count === 1 ? "" : "s"} filtered`;
  }
}

$("adblockToggle").addEventListener("change", async event => {
  setMessage(event.target.checked ? "Enabling stealth ad rules…" : "Disabling ad rules…");
  const response = await chrome.runtime.sendMessage({ type: "SET_ADBLOCK_ENABLED", enabled: event.target.checked });
  setMessage(response?.ok ? "Ad Shield updated. Reload affected tabs." : response?.error || "Ad Shield change failed.", !response?.ok);
  await load();
});
$("siteAdToggle").addEventListener("click", async () => {
  if (!currentHost) return setMessage("This browser page cannot be changed.", true);
  const result = await chrome.runtime.sendMessage({ type: "TOGGLE_ADBLOCK_SITE", domain: currentHost });
  setMessage(result.allowed ? "Ads allowed for this site. Reloading…" : "Ad blocking restored. Reloading…");
  if (tabId != null) await chrome.tabs.reload(tabId);
  window.close();
});
$("youtubeToggle").addEventListener("click", async () => {
  if (tabId == null) return;
  if (youtubeBypassed) {
    await chrome.runtime.sendMessage({ type: "CLEAR_YOUTUBE_BYPASS", tabId });
    setMessage("Temporary YouTube bypass removed. Reloading…");
  } else {
    const enabled = !currentConfig.adblock.youtube.enabled;
    const response = await chrome.runtime.sendMessage({ type: "SET_YOUTUBE_ADBLOCK", enabled, mode: currentConfig.adblock.youtube.mode });
    if (!response?.ok) return setMessage(response?.error || "YouTube toggle failed.", true);
    setMessage(enabled ? "YouTube Shield enabled. Reloading…" : "YouTube Shield disabled. Reloading…");
  }
  await chrome.tabs.reload(tabId);
  window.close();
});

$("masterToggle").addEventListener("change", async event => {
  await chrome.runtime.sendMessage({ type: "SET_ENABLED", enabled: event.target.checked });
  await load();
});
$("profileSelect").addEventListener("change", async event => {
  setMessage("Applying profile…");
  const response = await chrome.runtime.sendMessage({ type: "SET_PROFILE", profile: event.target.value });
  setMessage(response?.ok ? "Profile applied to new page loads." : response?.error || "Profile change failed.", !response?.ok);
  await load();
});
$("siteToggle").addEventListener("click", async () => {
  if (!currentHost) return setMessage("This browser page cannot be allowlisted.", true);
  const result = await chrome.runtime.sendMessage({ type: "TOGGLE_SITE", domain: currentHost });
  setMessage(result.allowed ? "Site trusted. Reloading…" : "Protection restored. Reloading…");
  if (tabId != null) await chrome.tabs.reload(tabId);
  window.close();
});
$("updateFeeds").addEventListener("click", async () => {
  $("updateFeeds").disabled = true;
  setMessage("Downloading and compiling threat intelligence…");
  try {
    const result = await chrome.runtime.sendMessage({ type: "UPDATE_FEEDS" });
    setMessage(result.ok ? `Loaded ${fmt(result.domains)} domains.` : `Updated with warnings: ${(result.errors || []).join(" | ")}`, !result.ok);
    await load();
  } finally {
    $("updateFeeds").disabled = false;
  }
});
$("relayAction").addEventListener("click", async () => {
  const relay = currentConfig.relay;
  if (!relay.endpoints.length) return chrome.runtime.openOptionsPage();
  $("relayAction").disabled = true;
  try {
    if (relay.enabled) {
      const response = await chrome.runtime.sendMessage({ type: "RELAY_DISCONNECT" });
      if (!response?.ok) throw new Error(response?.error || "Relay disconnect failed.");
      setMessage("Relay disconnected. Normal system route restored.");
    } else if (relay.strategy === "smart" && relay.endpoints.filter(item => item.enabled).length > 1) {
      setMessage("Testing trusted relays and selecting the fastest healthy route…");
      const response = await chrome.runtime.sendMessage({ type: "RELAY_BENCHMARK" });
      if (!response?.ok) throw new Error(response?.error || "No configured relay passed the connectivity test.");
      setMessage(`Connected through ${response.activeLabel}.`);
    } else {
      const response = await chrome.runtime.sendMessage({ type: "RELAY_CONNECT", endpointId: relay.activeEndpointId });
      if (!response?.ok) throw new Error(response?.relay?.lastError || response?.error || "Relay connection failed.");
      setMessage(`Connected through ${response.relay.activeLabel}.`);
    }
    await load();
  } catch (error) {
    setMessage(error.message, true);
  } finally {
    $("relayAction").disabled = false;
  }
});
$("ipCheck").addEventListener("click", async () => {
  $("ipCheck").disabled = true;
  setMessage("Checking the browser’s externally observed address…");
  try {
    const response = await chrome.runtime.sendMessage({ type: "CHECK_PUBLIC_IP" });
    if (!response?.ok) throw new Error((response?.errors || []).join(" | ") || "Public IP check failed.");
    $("publicIp").textContent = `Observed IP: ${response.observed.join(", ")}`;
    setMessage(response.observed.length > 1 ? "Observers disagreed. Review the route and retry." : "Public IP observation completed.", response.observed.length > 1);
  } catch (error) {
    setMessage(error.message, true);
  } finally {
    $("ipCheck").disabled = false;
  }
});
$("openOptions").addEventListener("click", () => chrome.runtime.openOptionsPage());
load().catch(error => setMessage(error.message, true));

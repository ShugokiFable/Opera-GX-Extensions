import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workerPath = path.join(root, "background/service_worker.js");
const source = fs.readFileSync(workerPath, "utf8").split("chrome.runtime.onInstalled")[0];

const calls = [];
const setting = name => ({
  set: async args => calls.push({ type: "setting.set", name, args }),
  clear: async args => calls.push({ type: "setting.clear", name, args })
});
const proxySettings = {
  get: async () => ({ levelOfControl: "controllable_by_this_extension", value: { mode: "direct" } }),
  set: async args => calls.push({ type: "proxy.set", args }),
  clear: async args => calls.push({ type: "proxy.clear", args })
};
const chrome = {
  proxy: { settings: proxySettings },
  privacy: {
    websites: {
      hyperlinkAuditingEnabled: setting("hyperlinkAuditingEnabled"),
      referrersEnabled: setting("referrersEnabled"),
      doNotTrackEnabled: setting("doNotTrackEnabled"),
      thirdPartyCookiesAllowed: setting("thirdPartyCookiesAllowed"),
      topicsEnabled: setting("topicsEnabled"),
      fledgeEnabled: setting("fledgeEnabled"),
      adMeasurementEnabled: setting("adMeasurementEnabled"),
      relatedWebsiteSetsEnabled: setting("relatedWebsiteSetsEnabled")
    },
    network: {
      networkPredictionEnabled: setting("networkPredictionEnabled"),
      webRTCIPHandlingPolicy: setting("webRTCIPHandlingPolicy")
    },
    services: {
      searchSuggestEnabled: setting("searchSuggestEnabled"),
      safeBrowsingEnabled: setting("safeBrowsingEnabled"),
      safeBrowsingExtendedReportingEnabled: setting("safeBrowsingExtendedReportingEnabled")
    }
  },
  contentSettings: {
    notifications: setting("notifications"),
    location: setting("location"),
    camera: setting("camera"),
    microphone: setting("microphone"),
    automaticDownloads: setting("automaticDownloads")
  }
};
const context = vm.createContext({
  console, URL, Set, Map, Object, Array, Number, String, RegExp, Date, Math, JSON,
  AbortController, setTimeout, clearTimeout, structuredClone, performance, chrome
});
vm.runInContext(source, context, { filename: workerPath });

const config = vm.runInContext("structuredClone(DEFAULTS)", context);
config.enabled = false;
config.relay.enabled = true;
config.relay.failClosed = true;
config.relay.bypassLocal = true;
config.relay.endpoints = [{ name: "Contract relay", scheme: "https", host: "relay.example", port: 443 }];
config.relay = vm.runInContext("normalizeRelayConfig(__cfg)", Object.assign(context, { __cfg: config.relay }));

await vm.runInContext("setRelayProxy(__ep, __relay)", Object.assign(context, {
  __ep: config.relay.endpoints[0],
  __relay: config.relay
}));
const proxyCall = calls.find(call => call.type === "proxy.set");
if (!proxyCall) throw new Error("Proxy API was not invoked");
if (proxyCall.args.value.mode !== "pac_script" || proxyCall.args.value.pacScript.mandatory !== true) {
  throw new Error("Relay proxy contract is not mandatory PAC fail-closed");
}
if (/; DIRECT/.test(proxyCall.args.value.pacScript.data)) {
  throw new Error("Fail-closed relay PAC contains a public direct fallback");
}

calls.length = 0;
await vm.runInContext("applyPrivacySettings(__config)", Object.assign(context, { __config: config }));
const webrtcCall = calls.find(call => call.type === "setting.set" && call.name === "webRTCIPHandlingPolicy");
if (webrtcCall?.args?.value !== "disable_non_proxied_udp") {
  throw new Error("Relay did not force WebRTC non-proxied UDP protection while the main shield was paused");
}
const dntCall = calls.find(call => call.name === "doNotTrackEnabled");
if (dntCall?.type !== "setting.clear") throw new Error("Paused shield failed to release DNT control");

calls.length = 0;
config.enabled = true;
config.privacy.blockNotifications = true;
config.privacy.blockAutomaticDownloads = true;
config.privacy.blockGeolocation = false;
await vm.runInContext("applyPermissionFirewall(__config)", Object.assign(context, { __config: config }));
const notificationBlock = calls.find(call => call.type === "setting.set" && call.name === "notifications");
const downloadBlock = calls.find(call => call.type === "setting.set" && call.name === "automaticDownloads");
const geolocationBlock = calls.find(call => call.type === "setting.set" && call.name === "location");
if (notificationBlock?.args?.setting !== "block" || downloadBlock?.args?.setting !== "block") {
  throw new Error("Permission firewall did not apply expected global blocks");
}
if (geolocationBlock) throw new Error("Permission firewall blocked a disabled category");

console.log("Aegis API contract test passed: mandatory relay PAC, WebRTC leak protection, privacy release behavior, and content-permission firewall.");

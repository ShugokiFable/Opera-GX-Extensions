import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workerPath = path.join(root, "background/service_worker.js");
const source = fs.readFileSync(workerPath, "utf8").split("chrome.runtime.onInstalled")[0];
const calls = [];
const sessionStore = {};
const chrome = {
  declarativeNetRequest: {
    updateEnabledRulesets: async args => calls.push({ type: "rulesets", args }),
    getDynamicRules: async () => [],
    updateDynamicRules: async args => calls.push({ type: "dynamic", args }),
    getSessionRules: async () => [],
    updateSessionRules: async args => calls.push({ type: "session", args })
  },
  scripting: {
    unregisterContentScripts: async args => calls.push({ type: "unregister", args }),
    registerContentScripts: async args => calls.push({ type: "register", args })
  },
  storage: {
    session: {
      get: async keys => {
        if (keys == null) return { ...sessionStore };
        const list = Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(list.filter(key => key in sessionStore).map(key => [key, sessionStore[key]]));
      },
      set: async values => Object.assign(sessionStore, values),
      remove: async keys => { for (const key of Array.isArray(keys) ? keys : [keys]) delete sessionStore[key]; }
    }
  }
};
const context = vm.createContext({
  console, URL, Set, Map, Object, Array, Number, String, RegExp, Date, Math, JSON,
  AbortController, setTimeout, clearTimeout, structuredClone, performance, chrome
});
vm.runInContext(source, context, { filename: workerPath });

const config = vm.runInContext("structuredClone(DEFAULTS)", context);
config.enabled = false;
config.adblock.enabled = true;
config.adblock.youtube.enabled = false;
await vm.runInContext("updateRulesetState(__config)", Object.assign(context, { __config: config }));
let call = calls.find(item => item.type === "rulesets");
if (!call.args.enableRulesetIds.includes("ad_stealth") || call.args.enableRulesetIds.includes("youtube_stealth")) {
  throw new Error("Independent ad ruleset toggle failed");
}
if (!call.args.disableRulesetIds.includes("security_core")) throw new Error("Main shield did not remain independently paused");

calls.length = 0;
config.adblock.youtube.enabled = true;
config.adblock.youtube.mode = "network";
await vm.runInContext("registerContentGuards(__config)", Object.assign(context, { __config: config }));
call = calls.find(item => item.type === "register");
if (!call || call.args.some(script => script.id === "aegis-youtube-adshield")) {
  throw new Error("Network-only YouTube mode injected a page content script");
}

calls.length = 0;
config.adblock.youtube.mode = "adaptive";
await vm.runInContext("registerContentGuards(__config)", Object.assign(context, { __config: config }));
call = calls.find(item => item.type === "register");
const youtubeScript = call?.args?.find(script => script.id === "aegis-youtube-adshield");
if (!youtubeScript || youtubeScript.world !== "ISOLATED" || youtubeScript.runAt !== "document_start") {
  throw new Error("Adaptive YouTube script registration contract failed");
}

calls.length = 0;
await vm.runInContext("setYoutubeTabBypass(42, true)", context);
call = calls.find(item => item.type === "session");
const bypass = call?.args?.addRules?.[0];
if (!bypass || bypass.priority !== 900 || !bypass.condition.tabIds.includes(42)) throw new Error("YouTube tab bypass rule was not scoped correctly");
if (!bypass.condition.initiatorDomains.includes("youtube.com")) throw new Error("YouTube tab bypass lacks initiator scoping");
if (bypass.priority >= 10000) throw new Error("YouTube fallback would override threat rules");

const guardSource = fs.readFileSync(path.join(root, "content/guard.js"), "utf8");
if (!guardSource.includes('config.adblock.youtube?.mode !== "network"')) {
  throw new Error("Network-only YouTube mode can still trigger cosmetic DOM changes");
}
const privacyRules = JSON.parse(fs.readFileSync(path.join(root, "rules/privacy_core.json"), "utf8"));
if (privacyRules.some(rule => Number(rule.priority) <= 1000)) {
  throw new Error("Ad-only allow rules could override tracking-parameter protection");
}

console.log("Aegis Ad Shield test passed: independent rulesets, zero-script network mode, isolated adaptive mode, and threat-preserving tab fallback.");

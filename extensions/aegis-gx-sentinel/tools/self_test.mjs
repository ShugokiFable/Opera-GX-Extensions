import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workerPath = path.join(root, "background/service_worker.js");
const workerPrefix = fs.readFileSync(workerPath, "utf8").split("chrome.runtime.onInstalled")[0];
const context = vm.createContext({
  console, URL, Set, Map, Object, Array, Number, String, RegExp, Date, Math, JSON,
  AbortController, setTimeout, clearTimeout, structuredClone, performance, chrome: {}
});
vm.runInContext(workerPrefix, context, { filename: workerPath });

function evaluate(expression, values = {}) {
  Object.assign(context, values);
  return vm.runInContext(expression, context);
}

const hostCases = [
  ["fckeditor.com", false], ["fdic.gov", false], ["fc00::1", true],
  ["fd12::1", true], ["fe80::1", true], ["[::1]", true],
  ["192.168.1.2", true], ["172.31.2.3", true], ["172.32.2.3", false],
  ["8.8.8.8", false]
];
for (const [host, expected] of hostCases) {
  const actual = evaluate("isPrivateOrLocalHost(__host)", { __host: host });
  if (actual !== expected) throw new Error(`Host classification failed for ${host}: ${actual} != ${expected}`);
}

const feedText = [
  "# comment", "0.0.0.0 evil.example", "||tracker.example^", "*.ads.example",
  "https://malware.example/payload.exe", "invalid"
].join("\n");
const domains = evaluate("Array.from(parseFeed(__feedText)).sort()", { __feedText: feedText });
const expectedDomains = ["ads.example", "evil.example", "malware.example", "tracker.example"];
if (JSON.stringify(domains) !== JSON.stringify(expectedDomains)) {
  throw new Error(`Feed parser mismatch: ${JSON.stringify(domains)}`);
}

const sampleDomains = new Set(Array.from({ length: 1001 }, (_, i) => `d${i}.example`));
const sampleAds = new Set(Array.from({ length: 401 }, (_, i) => `ad${i}.example`));
const ruleConfig = evaluate("structuredClone(DEFAULTS)");
ruleConfig.allowlist = ["trusted.example"];
ruleConfig.adblock.allowlist = ["ads-ok.example"];
const rules = evaluate("buildDynamicRules(__domains, __ads, __config)", { __domains: sampleDomains, __ads: sampleAds, __config: ruleConfig });
if (rules.length !== 7) throw new Error(`Expected 7 batched rules, received ${rules.length}`);
if (rules[0].action.type !== "allowAllRequests" || rules[0].priority !== 30000) {
  throw new Error("Full allowlist rule invariant failed");
}
function httpHostEquals(value, host) {
  const url = new URL(`https://${value}`);
  return (url.protocol === "http:" || url.protocol === "https:") && url.hostname === host;
}
const adAllow = rules.find(rule => rule.action.type === "allow" && (rule.condition.initiatorDomains || []).some(domain => httpHostEquals(domain, "ads-ok.example")));
if (!adAllow || adAllow.priority >= 10000 || adAllow.priority <= 100) throw new Error("Ad-only allowlist priority invariant failed");
const adBlock = rules.find(rule => rule.priority === 100 && (rule.condition.requestDomains || []).some(domain => httpHostEquals(domain, "ad0.example")));
if (!(adBlock?.condition?.excludedInitiatorDomains || []).some(domain => httpHostEquals(domain, "youtube.com"))) throw new Error("General ad rules do not exclude YouTube");

const phishing = evaluate("analyzeUrl('http://paypal-login-verify.example.zip/account/security')");
if (phishing.score < 55) throw new Error(`Phishing heuristic under-scored sample URL: ${phishing.score}`);
const ordinary = evaluate("analyzeUrl('https://accounts.google.com/')");
if (ordinary.score >= 55) throw new Error(`Ordinary URL over-scored: ${ordinary.score}`);

const endpoint = evaluate("sanitizeEndpoint({name:'Test',scheme:'socks5',host:'[2001:db8::1]',port:1080}, 0)");
if (endpoint.host !== "2001:db8::1" || endpoint.scheme !== "socks5" || endpoint.port !== 1080 || !endpoint.id) {
  throw new Error(`Relay endpoint normalization failed: ${JSON.stringify(endpoint)}`);
}
const badPort = evaluate("sanitizeEndpoint({scheme:'https',host:'relay.example',port:12.5}, 0)");
if (badPort.port !== 443) throw new Error(`Invalid relay port did not fall back safely: ${badPort.port}`);

const failClosedPac = evaluate("buildRelayPacScript(__endpoint, {failClosed:true,bypassLocal:true})", { __endpoint: endpoint });
const pacContext = vm.createContext({
  isPlainHostName: host => !host.includes("."),
  dnsDomainIs: (host, suffix) => host.endsWith(suffix),
  shExpMatch: (value, pattern) => new RegExp(`^${pattern.replace(/[.+^${}()|[\\]\\]/g, "\\$&").replaceAll("*", ".*").replaceAll("?", ".")}$`).test(value)
});
vm.runInContext(failClosedPac, pacContext);
const publicRoute = vm.runInContext("FindProxyForURL('https://example.com/', 'example.com')", pacContext);
const localRoute = vm.runInContext("FindProxyForURL('http://192.168.1.1/', '192.168.1.1')", pacContext);
if (publicRoute.includes("DIRECT")) throw new Error(`Fail-closed PAC leaked a direct fallback: ${publicRoute}`);
if (localRoute !== "DIRECT") throw new Error(`Local bypass PAC invariant failed: ${localRoute}`);
const failOpenPac = evaluate("buildRelayPacScript(__endpoint, {failClosed:false,bypassLocal:false})", { __endpoint: endpoint });
const openContext = vm.createContext({});
vm.runInContext(failOpenPac, openContext);
if (!vm.runInContext("FindProxyForURL('https://example.com/', 'example.com')", openContext).endsWith("; DIRECT")) {
  throw new Error("Fail-open PAC is missing its explicit direct fallback.");
}

console.log("Aegis self-test passed: feed parsing, URL heuristics, split threat/ad DNR batching, YouTube isolation, host classification, relay normalization, and PAC fail-closed behavior.");

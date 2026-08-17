import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(root, "manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
if (manifest.manifest_version !== 3) throw new Error("Manifest must be v3");
// Pinning a literal version here meant every release bumped a passing suite into
// a failing one. Check the shape instead, and that version_name still agrees.
if (!/^\d+\.\d+\.\d+$/.test(manifest.version ?? "")) throw new Error(`Malformed version: ${manifest.version}`);
if (manifest.version_name && !manifest.version_name.startsWith(manifest.version)) {
  throw new Error(`version_name "${manifest.version_name}" does not match version ${manifest.version}`);
}

const requiredRulesets = ["privacy_core", "security_core", "lan_shield", "ad_stealth", "youtube_stealth"];
for (const id of requiredRulesets) {
  if (!manifest.declarative_net_request.rule_resources.some(item => item.id === id)) throw new Error(`Missing ruleset: ${id}`);
}

const requiredPermissions = [
  "browsingData", "contentSettings", "declarativeNetRequestWithHostAccess", "privacy",
  "proxy", "webRequest", "webRequestAuthProvider"
];
for (const permission of requiredPermissions) {
  if (!manifest.permissions.includes(permission)) throw new Error(`Missing required permission: ${permission}`);
}

const referenced = [
  manifest.background.service_worker,
  manifest.action.default_popup,
  manifest.options_ui.page,
  ...Object.values(manifest.icons),
  ...manifest.declarative_net_request.rule_resources.map(x => x.path)
];
for (const file of referenced) {
  if (!fs.existsSync(path.join(root, file))) throw new Error(`Missing manifest file: ${file}`);
}

let staticRuleCount = 0;
for (const ruleset of manifest.declarative_net_request.rule_resources) {
  const data = JSON.parse(fs.readFileSync(path.join(root, ruleset.path), "utf8"));
  if (!Array.isArray(data)) throw new Error(`${ruleset.path} must contain an array`);
  const ids = new Set();
  for (const entry of data) {
    if (!Number.isInteger(entry.id) || entry.id < 1) throw new Error(`Invalid rule id in ${ruleset.path}`);
    if (ids.has(entry.id)) throw new Error(`Duplicate rule id ${entry.id} in ${ruleset.path}`);
    if (!entry.action?.type || !entry.condition) throw new Error(`Incomplete rule ${entry.id} in ${ruleset.path}`);
    if (entry.condition.regexFilter) new RegExp(entry.condition.regexFilter);
    ids.add(entry.id);
    staticRuleCount += 1;
  }
}

const jsFiles = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p);
    else if (p.endsWith(".js")) jsFiles.push(p);
  }
}
walk(root);
for (const file of jsFiles) {
  const source = fs.readFileSync(file, "utf8");
  new vm.Script(source, { filename: file });
  if (/\beval\s*\(|\bnew\s+Function\s*\(/.test(source)) throw new Error(`Remote-code-risk primitive found in ${file}`);
}


function validatePage(htmlRelative, jsRelative) {
  const html = fs.readFileSync(path.join(root, htmlRelative), "utf8");
  const js = fs.readFileSync(path.join(root, jsRelative), "utf8");
  const ids = new Set(Array.from(html.matchAll(/\bid=["']([^"']+)["']/g), match => match[1]));
  const usedIds = new Set(Array.from(js.matchAll(/\$\(["']([^"']+)["']\)/g), match => match[1]));
  for (const id of usedIds) {
    if (!ids.has(id)) throw new Error(`${jsRelative} references missing #${id} in ${htmlRelative}`);
  }
  for (const match of html.matchAll(/<(?:script|link)[^>]+(?:src|href)=["']([^"']+)["']/g)) {
    const target = match[1];
    if (/^(?:https?:|data:|#)/.test(target)) continue;
    const resolved = path.resolve(path.dirname(path.join(root, htmlRelative)), target);
    if (!fs.existsSync(resolved)) throw new Error(`${htmlRelative} references missing asset ${target}`);
  }
}
validatePage("popup/popup.html", "popup/popup.js");
validatePage("options/options.html", "options/options.js");
validatePage("warning/warning.html", "warning/warning.js");

const workerSource = fs.readFileSync(path.join(root, manifest.background.service_worker), "utf8");
for (const match of workerSource.matchAll(/["']((?:content|warning|assets)\/[^"']+)["']/g)) {
  const relative = match[1];
  if (!fs.existsSync(path.join(root, relative))) throw new Error(`Service worker references missing file: ${relative}`);
}

const forbiddenFiles = [];
function findForbidden(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) findForbidden(p);
    else if (/\.(pem|key|p12|pfx)$/i.test(entry.name)) forbiddenFiles.push(path.relative(root, p));
  }
}
findForbidden(root);
if (forbiddenFiles.length) throw new Error(`Private key material must not be packaged: ${forbiddenFiles.join(", ")}`);

console.log(`Validated ${referenced.length} manifest references, ${manifest.declarative_net_request.rule_resources.length} rulesets (${staticRuleCount} static rules), and ${jsFiles.length} JavaScript files.`);

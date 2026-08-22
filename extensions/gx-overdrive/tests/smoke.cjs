'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

function event() {
  const listeners = [];
  return {
    addListener(fn) { listeners.push(fn); },
    listeners
  };
}

const localStore = {};
const discarded = [];
const events = {
  installed: event(),
  startup: event(),
  alarm: event(),
  downloadCreated: event(),
  downloadChanged: event(),
  menuClicked: event(),
  command: event(),
  message: event(),
  storageChanged: event()
};

const tabs = [
  { id: 1, active: true, discarded: false, pinned: false, audible: false, url: 'https://chatgpt.com/c/test', lastAccessed: Date.now() },
  { id: 2, active: false, discarded: false, pinned: false, audible: false, url: 'https://example.com/', lastAccessed: Date.now() - 10_000_000 },
  { id: 3, active: false, discarded: false, pinned: true, audible: false, url: 'https://pinned.example/', lastAccessed: Date.now() - 10_000_000 }
];

function store(backing) {
  return {
    async get(keys) {
      if (typeof keys === 'string') return { [keys]: backing[keys] };
      const result = {};
      for (const key of keys || Object.keys(backing)) result[key] = backing[key];
      return result;
    },
    async set(values) { Object.assign(backing, values); }
  };
}

const sessionStore = {};
let freeRatio = 40 / 64;

const chrome = {
  storage: {
    local: store(localStore),
    session: store(sessionStore),
    onChanged: events.storageChanged
  },
  system: {
    memory: {
      async getInfo() {
        return { capacity: 64 * 1024 ** 3, availableCapacity: Math.round(64 * 1024 ** 3 * freeRatio) };
      }
    }
  },
  tabs: {
    async query(query) {
      let result = tabs;
      if (query?.active) result = result.filter((tab) => tab.active);
      // The real query applies these filters server-side. A mock that ignores
      // them cannot catch a caller that relies on them to find work.
      if (Array.isArray(query?.url)) result = result.filter((tab) => tab.url.startsWith('http'));
      if (typeof query?.autoDiscardable === 'boolean') {
        result = result.filter((tab) => (tab.autoDiscardable !== false) === query.autoDiscardable);
      }
      return result;
    },
    async sendMessage() { return { canDiscard: true }; },
    async update(id, props) {
      const tab = tabs.find((item) => item.id === id);
      if (!tab) throw new Error('No tab with id: ' + id);
      return Object.assign(tab, props);
    },
    async discard(id) {
      const tab = tabs.find((item) => item.id === id);
      if (tab) tab.discarded = true;
      discarded.push(id);
      return tab;
    }
  },
  windows: { async update() {} },
  downloads: {
    async search() { return []; },
    async pause() {},
    async resume() {},
    async show() {},
    onCreated: events.downloadCreated,
    onChanged: events.downloadChanged
  },
  power: {
    requestKeepAwake() {},
    releaseKeepAwake() {}
  },
  browsingData: {
    async removeCache() {},
    async removeCacheStorage() {}
  },
  alarms: {
    async create() {},
    onAlarm: events.alarm
  },
  contextMenus: {
    async removeAll() {},
    create() {},
    onClicked: events.menuClicked
  },
  action: {
    async setBadgeText() {},
    async setBadgeBackgroundColor() {},
    async setTitle() {}
  },
  commands: { onCommand: events.command },
  runtime: {
    onInstalled: events.installed,
    onStartup: events.startup,
    onMessage: events.message,
    async openOptionsPage() {}
  }
};

const context = vm.createContext({ chrome, console, URL, setTimeout, clearTimeout, Date, Math, Promise });
const source = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
vm.runInContext(source, context, { filename: 'background.js' });

function send(message) {
  return new Promise((resolve, reject) => {
    const listener = events.message.listeners[0];
    assert(listener, 'runtime message listener registered');
    const timeout = setTimeout(() => reject(new Error('message response timeout')), 2000);
    listener(message, {}, (response) => {
      clearTimeout(timeout);
      resolve(response);
    });
  });
}

(async () => {
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(localStore.settings.memoryPressurePercent, 8, '64 GiB adaptive profile selected');
  assert.equal(localStore.settings.chatMaxVisibleTurns, 90, 'high-memory chat profile selected');

  const result = await send({ type: 'GX_HIBERNATE_OTHERS' });
  assert.equal(result.discarded, 1, 'only one eligible background tab discarded');
  assert.deepEqual(discarded, [2], 'pinned and active tabs protected');

  const state = await send({ type: 'GX_GET_STATE' });
  assert.equal(state.tabs.total, 3);
  assert.equal(state.tabs.discarded, 1);
  assert.equal(state.settings.protectPinned, true);
  assert.equal(state.hibernationLog.length, 1, 'hibernated tab recorded for restore');
  assert.equal(state.hibernationLog[0].id, 2);

  // Regression: disabling both hibernation engines must stop tab unloading.
  const governorTick = () => {
    const listener = events.alarm.listeners[0];
    listener({ name: 'gx-overdrive-governor' });
    return new Promise((resolve) => setTimeout(resolve, 30));
  };

  tabs.push({ id: 4, active: false, discarded: false, pinned: false, audible: false, url: 'https://cold.example/', lastAccessed: Date.now() - 10_000_000 });
  freeRatio = 0.01; // hard memory pressure
  await send({ type: 'GX_SAVE_SETTINGS', patch: { autoHibernate: false, memoryGovernor: false } });
  await governorTick();
  assert.deepEqual(discarded, [2], 'no tab hibernated while both engines are off');
  assert.equal(tabs.find((tab) => tab.id === 4).autoDiscardable, false, 'open tabs opted out of native sleeping when hibernation was switched off');

  // Regression: a tab opened AFTER hibernation was switched off must be opted
  // out too. Caching the last synced value made the minute tick return early,
  // so every tab opened later stayed browser-discardable and Opera slept it.
  tabs.push({ id: 7, active: false, discarded: false, pinned: false, audible: false, url: 'https://opened-later.example/', lastAccessed: Date.now() });
  await governorTick();
  assert.equal(tabs.find((tab) => tab.id === 7).autoDiscardable, false, 'tab opened after the toggle is opted out on the next tick');

  // Regression: the emergency sweep must not fire again inside its cooldown.
  await send({ type: 'GX_SAVE_SETTINGS', patch: { memoryGovernor: true, emergencyDiscardBatch: 1 } });
  await governorTick();
  assert.deepEqual(discarded, [2, 4], 'pressure sweep hibernated one cold tab');
  assert.notEqual(tabs.find((tab) => tab.id === 7).autoDiscardable, false, 're-enabling hibernation hands tabs back to the browser');
  tabs.push({ id: 5, active: false, discarded: false, pinned: false, audible: false, url: 'https://cold2.example/', lastAccessed: Date.now() - 10_000_000 });
  await governorTick();
  assert.deepEqual(discarded, [2, 4], 'cooldown blocked a second sweep one minute later');

  // Regression: recently used tabs survive the emergency sweep even when the
  // batch is big enough to take them.
  tabs.push({ id: 6, active: false, discarded: false, pinned: false, audible: false, url: 'https://fresh.example/', lastAccessed: Date.now() - 20_000 });
  sessionStore.governor = {};
  await send({ type: 'GX_SAVE_SETTINGS', patch: { emergencyDiscardBatch: 5 } });
  await governorTick();
  assert.ok(discarded.includes(5), 'cold tab still hibernated once the cooldown expired');
  assert.ok(!discarded.includes(6), 'tab used 20 seconds ago is protected by the idle floor');

  const restored = await send({ type: 'GX_RESTORE_TAB', id: 2 });
  assert.equal(restored.ok, true, 'hibernated tab can be restored from the dashboard');

  const site = await send({ type: 'GX_SET_SITE_PROTECTION', protected: true });
  assert.equal(site.protected, true);
  assert.ok(site.settings.whitelist.includes('chatgpt.com'), 'active host added to the never-hibernate list');
  const unset = await send({ type: 'GX_SET_SITE_PROTECTION', protected: false });
  assert.ok(!unset.settings.whitelist.includes('chatgpt.com'), 'site protection can be removed again');

  console.log('GX Overdrive background smoke test: PASS');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

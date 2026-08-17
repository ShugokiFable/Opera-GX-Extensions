const MENU_IDS = {
  open: 'nexus-open',
  selection: 'nexus-research-selection',
  page: 'nexus-research-page',
  link: 'nexus-research-link'
} as const;

function isOperaBrowser(): boolean {
  return /\bOPR\//i.test(navigator.userAgent) || /Opera/i.test(navigator.userAgent);
}

async function disableAutomaticSidePanelAction(): Promise<void> {
  // NEXUS handles toolbar clicks itself so every Chromium browser gets a
  // deterministic fallback. This also clears the behavior used by v1.0.0.
  if (chrome.sidePanel?.setPanelBehavior) {
    await chrome.sidePanel
      .setPanelBehavior({ openPanelOnActionClick: false })
      .catch(() => undefined);
  }
}

async function openNexusTab(): Promise<void> {
  const nexusUrl = chrome.runtime.getURL('sidepanel.html');

  try {
    const existing = await chrome.tabs.query({ url: nexusUrl });
    const current = existing[0];
    if (current?.id !== undefined) {
      await chrome.tabs.update(current.id, { active: true });
      if (current.windowId !== undefined) {
        await chrome.windows.update(current.windowId, { focused: true }).catch(() => undefined);
      }
      return;
    }
  } catch {
    // A fresh tab is still a reliable fallback if querying fails.
  }

  await chrome.tabs.create({ url: nexusUrl });
}

async function openNexus(tab?: chrome.tabs.Tab): Promise<void> {
  // Opera GX does not consistently implement Chrome's sidePanel action path.
  // Use a normal extension tab there. Chrome/Edge retain the native side panel.
  if (!isOperaBrowser() && tab?.windowId !== undefined && chrome.sidePanel?.open) {
    try {
      await chrome.sidePanel.open({ windowId: tab.windowId });
      return;
    } catch {
      // Fall through to the cross-browser extension page.
    }
  }

  await openNexusTab();
}

function createMenu(properties: chrome.contextMenus.CreateProperties): void {
  chrome.contextMenus.create(properties, () => {
    // Read and intentionally discard unsupported-context errors on forks.
    void chrome.runtime.lastError;
  });
}

function configureContextMenus(): void {
  chrome.contextMenus.removeAll(() => {
    createMenu({
      id: MENU_IDS.open,
      title: 'Open NEXUS Research',
      contexts: ['action']
    });
    createMenu({
      id: MENU_IDS.selection,
      title: 'Research selection with NEXUS',
      contexts: ['selection']
    });
    createMenu({
      id: MENU_IDS.page,
      title: 'Research this page with NEXUS',
      contexts: ['page']
    });
    createMenu({
      id: MENU_IDS.link,
      title: 'Investigate link with NEXUS',
      contexts: ['link']
    });
  });
}

chrome.runtime.onInstalled.addListener(() => {
  void disableAutomaticSidePanelAction();
  configureContextMenus();
});

chrome.runtime.onStartup.addListener(() => {
  void disableAutomaticSidePanelAction();
  configureContextMenus();
});

chrome.action.onClicked.addListener((tab) => {
  void openNexus(tab);
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === MENU_IDS.open) {
    void openNexus(tab);
    return;
  }

  const payload = {
    createdAt: Date.now(),
    tabId: tab?.id,
    pageUrl: info.pageUrl ?? tab?.url ?? '',
    mode: info.menuItemId,
    text: info.selectionText ?? '',
    linkUrl: info.linkUrl ?? ''
  };

  void chrome.storage.session.set({ nexus_pending_context: payload }).then(() => openNexus(tab));
});

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (!message || typeof message !== 'object') return;
  const typed = message as { type?: string };
  if (typed.type === 'NEXUS_PING') {
    sendResponse({ ok: true, version: chrome.runtime.getManifest().version });
  }
});

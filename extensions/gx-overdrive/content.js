'use strict';

(() => {
  // Every assistant renders one conversation turn per repeated block; only the
  // selector differs. Each host lists candidates in preference order and the
  // first one that actually matches wins, so a site redesign degrades to "no
  // folding" instead of folding the wrong thing.
  const CHAT_HOSTS = [
    {
      hosts: ['chatgpt.com', 'chat.openai.com'],
      turns: ['article[data-testid^="conversation-turn"]', '[data-testid^="conversation-turn-"]'],
      marker: '[data-message-author-role]'
    },
    {
      hosts: ['claude.ai'],
      turns: ['div[data-test-render-count]', 'div.font-claude-message', '[data-testid="user-message"]'],
      marker: ''
    },
    {
      hosts: ['gemini.google.com'],
      turns: ['model-response', 'user-query'],
      marker: ''
    },
    {
      hosts: ['www.perplexity.ai', 'perplexity.ai'],
      turns: ['div[class*="pb-md"] > div[class*="border-b"]'],
      marker: ''
    },
    {
      hosts: ['aistudio.google.com'],
      turns: ['ms-chat-turn'],
      marker: ''
    }
  ];

  function matchChatHost() {
    const host = location.hostname.toLowerCase();
    return CHAT_HOSTS.find((entry) => entry.hosts.some((h) => host === h || host.endsWith(`.${h}`))) || null;
  }

  const state = {
    settings: null,
    observer: null,
    mediaObserver: null,
    optimizationQueued: false,
    chat: {
      profile: matchChatHost(),
      isChat: Boolean(matchChatHost()),
      manuallyRevealed: 0,
      toolbar: null,
      hiddenCount: 0,
      processedTurns: new WeakSet()
    }
  };

  const idle = (callback, timeout = 900) => {
    if ('requestIdleCallback' in window) {
      window.requestIdleCallback(callback, { timeout });
    } else {
      setTimeout(callback, 80);
    }
  };

  function uniqueElements(items) {
    return [...new Set(items.filter(Boolean))];
  }

  const EDITOR_SELECTOR = 'textarea, input:not([type="checkbox"]):not([type="radio"]):not([type="submit"]):not([type="button"]):not([type="hidden"]), [contenteditable="true"], [contenteditable=""]';

  // A sticky "user typed once" flag protected a tab forever, so hibernation
  // silently stopped working on any page with a search box. Check live content
  // instead: text that is still on screen is unsaved, text that is gone is not.
  function hasUnsavedInput() {
    for (const node of document.querySelectorAll(EDITOR_SELECTOR)) {
      if (node.isContentEditable) {
        if (node.textContent.trim()) return true;
        continue;
      }
      if (!node.value) continue;
      if (node.type === 'password' || node.value !== node.defaultValue) return true;
    }
    return false;
  }

  function applyRootClasses() {
    const root = document.documentElement;
    const settings = state.settings;
    if (!settings) return;
    root.classList.toggle('gxo-enabled', Boolean(settings.enabled));
    root.classList.toggle('gxo-reduce-animations', Boolean(settings.enabled && settings.reduceAnimations));
    root.classList.toggle('gxo-reduce-blur', Boolean(settings.enabled && settings.reduceBlur));
    root.classList.toggle('gxo-aggressive-containment', Boolean(settings.enabled && settings.aggressiveContainment));
    root.classList.toggle('gxo-chat-effects', Boolean(settings.enabled && settings.chatReduceEffects && state.chat.isChat));
  }

  function optimizeImages(root = document) {
    const settings = state.settings;
    if (!settings?.enabled || !settings.universalTurbo || !settings.lazyImages) return;
    root.querySelectorAll?.('img:not([data-gxo-image])').forEach((img) => {
      img.dataset.gxoImage = '1';
      if (!img.hasAttribute('loading') && img.getAttribute('fetchpriority') !== 'high') img.loading = 'lazy';
      if (!img.hasAttribute('decoding')) img.decoding = 'async';
    });
  }

  function optimizeVideos(root = document) {
    const settings = state.settings;
    if (!settings?.enabled || !settings.universalTurbo || !settings.pauseOffscreenMutedVideo) return;
    if (!state.mediaObserver) {
      state.mediaObserver = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          const video = entry.target;
          if (!(video instanceof HTMLVideoElement)) continue;
          if (!entry.isIntersecting && !video.paused && (video.muted || video.autoplay) && document.pictureInPictureElement !== video) {
            video.dataset.gxoPausedOffscreen = '1';
            video.pause();
          } else if (entry.isIntersecting && video.dataset.gxoPausedOffscreen === '1') {
            // Without this, anything scrolled past once stayed dead for good.
            delete video.dataset.gxoPausedOffscreen;
            if (video.paused) video.play().catch(() => {});
          }
        }
      }, { rootMargin: '300px 0px', threshold: 0.01 });
    }
    root.querySelectorAll?.('video:not([data-gxo-video])').forEach((video) => {
      video.dataset.gxoVideo = '1';
      video.preload = video.preload === 'auto' ? 'metadata' : video.preload;
      state.mediaObserver.observe(video);
    });
  }

  function findChatTurns() {
    const profile = state.chat.profile;
    if (!profile) return [];

    for (const selector of profile.turns) {
      let found;
      try {
        found = [...document.querySelectorAll(selector)];
      } catch {
        continue; // A malformed selector must never take the whole engine down.
      }
      const turns = uniqueElements(found).filter((element) => {
        if (!(element instanceof HTMLElement)) return false;
        if (profile.marker && !(element.matches(profile.marker) || element.querySelector(profile.marker))) return false;
        return true;
      });
      // Folding needs a real conversation. A handful of matches is more likely a
      // layout coincidence than a long thread, and folding those would hide page
      // furniture instead of old messages.
      if (turns.length >= 4) return turns;
    }
    return [];
  }

  function ensureChatToolbar() {
    if (state.chat.toolbar?.isConnected) return state.chat.toolbar;
    const toolbar = document.createElement('aside');
    toolbar.id = 'gxo-chat-toolbar';
    toolbar.setAttribute('aria-live', 'polite');
    toolbar.innerHTML = `
      <div class="gxo-chat-toolbar__pulse"></div>
      <div class="gxo-chat-toolbar__copy">
        <strong>GX Long-Thread Engine</strong>
        <span data-gxo-hidden>0 older turns folded</span>
      </div>
      <button type="button" data-gxo-reveal>Reveal</button>
      <button type="button" data-gxo-restore>All</button>
    `;
    toolbar.querySelector('[data-gxo-reveal]').addEventListener('click', () => {
      state.chat.manuallyRevealed += state.settings?.chatRevealBatch || 20;
      optimizeChat(true);
    });
    toolbar.querySelector('[data-gxo-restore]').addEventListener('click', () => {
      state.chat.manuallyRevealed = Number.MAX_SAFE_INTEGER;
      optimizeChat(true);
    });
    document.documentElement.appendChild(toolbar);
    state.chat.toolbar = toolbar;
    return toolbar;
  }

  function optimizeChat(force = false) {
    const settings = state.settings;
    if (!state.chat.isChat || !settings?.enabled || !settings.chatOptimizer) {
      document.querySelectorAll('.gxo-chat-turn.gxo-folded').forEach((node) => node.classList.remove('gxo-folded'));
      state.chat.toolbar?.remove();
      state.chat.toolbar = null;
      return { turns: 0, hidden: 0 };
    }

    const turns = findChatTurns();
    if (!turns.length) {
      // Site redesigned, or this page of the app has no conversation on it.
      document.querySelectorAll('.gxo-chat-turn.gxo-folded').forEach((node) => node.classList.remove('gxo-folded'));
      if (state.chat.toolbar) state.chat.toolbar.hidden = true;
      return { turns: 0, hidden: 0 };
    }
    for (const turn of turns) {
      turn.classList.add('gxo-chat-turn');
      if (!state.chat.processedTurns.has(turn)) {
        state.chat.processedTurns.add(turn);
        turn.dataset.gxoTurn = '1';
      }
    }

    const baseVisible = settings.chatMaxVisibleTurns;
    const visible = Math.min(turns.length, baseVisible + state.chat.manuallyRevealed);
    const foldCount = Math.max(0, turns.length - visible);

    turns.forEach((turn, index) => {
      turn.classList.toggle('gxo-folded', index < foldCount);
    });

    state.chat.hiddenCount = foldCount;
    if (foldCount > 0 || force) {
      const toolbar = ensureChatToolbar();
      const counter = toolbar.querySelector('[data-gxo-hidden]');
      if (counter) counter.textContent = `${foldCount} older turn${foldCount === 1 ? '' : 's'} folded`;
      toolbar.hidden = foldCount === 0;
    } else if (state.chat.toolbar) {
      state.chat.toolbar.hidden = true;
    }
    return { turns: turns.length, hidden: foldCount };
  }

  function applyAggressiveContainment(root = document) {
    const settings = state.settings;
    if (!settings?.enabled || !settings.universalTurbo || !settings.aggressiveContainment || state.chat.isChat) return;
    root.querySelectorAll?.('main > article, main > section, body > main > div > article').forEach((node) => {
      if (node instanceof HTMLElement && node.getBoundingClientRect().height > 500) node.classList.add('gxo-heavy-block');
    });
  }

  function optimize(root = document, forceChat = false) {
    applyRootClasses();
    optimizeImages(root);
    optimizeVideos(root);
    applyAggressiveContainment(root);
    const chat = optimizeChat(forceChat);
    return chat;
  }

  function queueOptimize(root = document) {
    if (state.optimizationQueued) return;
    state.optimizationQueued = true;
    idle(() => {
      state.optimizationQueued = false;
      optimize(root);
    });
  }

  async function loadSettings() {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'GX_GET_SETTINGS' });
      state.settings = response?.settings || {};
      optimize(document, true);
    } catch {
      state.settings = { enabled: false };
    }
  }


  state.observer = new MutationObserver((mutations) => {
    const root = mutations.find((mutation) => mutation.addedNodes?.length)?.target || document;
    queueOptimize(root instanceof Element ? root : document);
  });
  state.observer.observe(document.documentElement, { childList: true, subtree: true });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings?.newValue) {
      state.settings = changes.settings.newValue;
      state.chat.manuallyRevealed = 0;
      optimize(document, true);
    }
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === 'GX_CAN_DISCARD') {
      const dirtyForm = hasUnsavedInput();
      sendResponse({ canDiscard: !dirtyForm, dirtyForm, title: document.title });
      return;
    }
    if (message?.type === 'GX_APPLY_NOW') {
      state.chat.manuallyRevealed = 0;
      const result = optimize(document, true);
      sendResponse({ ok: true, ...result, url: location.href });
    }
  });

  loadSettings();
})();

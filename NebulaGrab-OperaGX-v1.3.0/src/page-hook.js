(() => {
  'use strict';
  if (window.__NEBULAGRAB_HOOKED__) return;
  window.__NEBULAGRAB_HOOKED__ = true;

  const emit = (detail) => {
    try { window.postMessage({ source: 'NEBULAGRAB_PAGE', ...detail }, '*'); } catch (_) {}
  };

  const reportUrl = (url, source, meta = {}) => {
    try {
      const absolute = new URL(String(url), location.href).href;
      emit({ type: 'RESOURCE', item: { url: absolute, source, pageUrl: location.href, ...meta } });
    } catch (_) {}
  };


  const sniffManifestText = (text, url, source) => {
    const sample = String(text || '').slice(0, 131072);
    if (/^\s*#EXTM3U\b/i.test(sample)) reportUrl(url, source, { kind: 'hls', mime: 'application/vnd.apple.mpegurl' });
    else if (/<(?:\w+:)?MPD\b/i.test(sample)) reportUrl(url, source, { kind: 'dash', mime: 'application/dash+xml' });
  };

  const sniffFetchManifest = async (response, fallbackUrl) => {
    try {
      const clone = response.clone();
      const reader = clone.body?.getReader();
      if (!reader) return;
      const chunks = [];
      let total = 0;
      while (total < 131072) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value?.length) {
          const slice = value.subarray(0, Math.min(value.length, 131072 - total));
          chunks.push(slice);
          total += slice.length;
        }
      }
      try { await reader.cancel(); } catch (_) {}
      const merged = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.length; }
      sniffManifestText(new TextDecoder('utf-8', { fatal: false }).decode(merged), response.url || fallbackUrl, 'fetch-manifest-sniff');
    } catch (_) {}
  };

  try {
    const nativeFetch = window.fetch;
    window.fetch = function patchedFetch(input, init) {
      const url = typeof input === 'string' ? input : input?.url;
      if (url) reportUrl(url, 'fetch-request');
      const promise = nativeFetch.apply(this, arguments);
      promise.then((response) => {
        try {
          reportUrl(response.url || url, 'fetch-response', {
            mime: response.headers.get('content-type') || '',
            size: Number(response.headers.get('content-length')) || null,
            statusCode: response.status
          });
          void sniffFetchManifest(response, url);
        } catch (_) {}
      }).catch(() => {});
      return promise;
    };
  } catch (_) {}

  try {
    const nativeOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function patchedOpen(method, url) {
      if (url) reportUrl(url, 'xhr-request');
      this.addEventListener('loadend', () => {
        try {
          reportUrl(this.responseURL || url, 'xhr-response', {
            mime: this.getResponseHeader('content-type') || '',
            size: Number(this.getResponseHeader('content-length')) || null,
            statusCode: this.status
          });
          if ((this.responseType === '' || this.responseType === 'text') && typeof this.responseText === 'string') {
            sniffManifestText(this.responseText, this.responseURL || url, 'xhr-manifest-sniff');
          }
        } catch (_) {}
      }, { once: true });
      return nativeOpen.apply(this, arguments);
    };
  } catch (_) {}

  try {
    const nativeCreate = URL.createObjectURL.bind(URL);
    URL.createObjectURL = function patchedCreateObjectURL(object) {
      const url = nativeCreate(object);
      const blobType = object?.constructor?.name || '';
      const blobSize = typeof object?.size === 'number' ? object.size : null;
      const mime = typeof object?.type === 'string' ? object.type : '';
      emit({
        type: 'RESOURCE',
        item: {
          url,
          kind: 'blob',
          source: 'object-url',
          pageUrl: location.href,
          blobType,
          blobSize,
          mime
        }
      });
      return url;
    };
  } catch (_) {}

  try {
    const nativeSrcSetter = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src')?.set;
    const nativeSrcGetter = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src')?.get;
    if (nativeSrcSetter && nativeSrcGetter) {
      Object.defineProperty(HTMLMediaElement.prototype, 'src', {
        configurable: true,
        enumerable: true,
        get: nativeSrcGetter,
        set(value) {
          if (value) reportUrl(value, this instanceof HTMLAudioElement ? 'media-src-audio' : 'media-src-video');
          return nativeSrcSetter.call(this, value);
        }
      });
    }
  } catch (_) {}
})();

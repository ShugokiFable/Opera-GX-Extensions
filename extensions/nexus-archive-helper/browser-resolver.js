(function (root) {
  'use strict';
  const C = root.NexusArchiveCore;
  if (!C) throw new Error('NexusArchiveCore must be loaded before NexusArchiveResolver.');

  function extractFiles(payload) {
    if (Array.isArray(payload)) return payload;
    if (payload && Array.isArray(payload.files)) return payload.files;
    return [];
  }

  async function safeRequest(request, url, label, warnings, state) {
    try {
      const value = await request(url);
      state.successes += 1;
      return value;
    } catch (err) {
      warnings.push(`${label}: ${C.errorMessage(err)}`);
      return null;
    }
  }

  async function resolveFiles(ref, request) {
    if (typeof request !== 'function') throw new Error('A request adapter is required.');
    const warnings = [];
    const lists = [];
    const state = { successes: 0 };

    if (ref.fileId) {
      const exactRaw = await safeRequest(request, C.fileInfoUrl(ref, ref.fileId), 'Exact file lookup', warnings, state);
      if (exactRaw) lists.push([exactRaw]);
    }

    const allRaw = await safeRequest(request, C.filesUrl(ref), 'File list', warnings, state);
    const allFiles = extractFiles(allRaw);
    if (allFiles.length) lists.push(allFiles);

    if (state.successes === 0 && warnings.length) {
      throw new Error(warnings.join(' · '));
    }

    const files = C.sortInteresting(C.mergeFiles(...lists));
    const exact = ref.fileId ? files.find((f) => f.fileId === ref.fileId) || null : null;
    return {
      ref,
      files,
      exact,
      interesting: C.interestingOnly(files),
      warnings: Array.from(new Set(warnings)),
    };
  }

  async function resolveDownload(ref, fileId, request) {
    const fid = Number(fileId || ref.fileId);
    if (!Number.isInteger(fid) || fid <= 0) throw new Error('A file ID is required for download.');
    const url = C.downloadLinkUrl(ref, fid);
    try {
      const payload = await request(url);
      const links = Array.isArray(payload) ? payload : (payload && Array.isArray(payload.links) ? payload.links : []);
      const first = links.find((x) => x && (x.URI || x.uri || x.url));
      if (!first) {
        return {
          mode: 'unavailable',
          url: null,
          reason: 'Nexus returned no downloadable CDN link for this file.',
        };
      }
      return {
        mode: 'direct',
        url: first.URI || first.uri || first.url,
        name: first.name || first.short_name || 'Nexus CDN',
        links,
      };
    } catch (err) {
      const status = Number(err && err.status) || 0;
      const reason = C.errorMessage(err);
      if (status === 401 || status === 403) {
        return {
          mode: 'website',
          url: C.websiteFileUrl(ref, fid, false),
          nxmUrl: C.websiteFileUrl(ref, fid, true),
          reason,
        };
      }
      if (status === 404) {
        return {
          mode: 'unavailable',
          url: null,
          reason,
        };
      }
      return {
        mode: 'website',
        url: C.websiteFileUrl(ref, fid, false),
        nxmUrl: C.websiteFileUrl(ref, fid, true),
        reason,
      };
    }
  }

  async function validateUser(request) {
    const raw = await request('https://api.nexusmods.com/v1/users/validate.json');
    return {
      id: Number(raw.user_id ?? raw.userId ?? raw.id) || null,
      name: String(raw.name ?? raw.username ?? ''),
      premium: Boolean(raw.is_premium ?? raw.isPremium ?? raw.premium),
    };
  }

  root.NexusArchiveResolver = Object.freeze({
    extractFiles,
    resolveFiles,
    resolveDownload,
    validateUser,
  });
})(globalThis);

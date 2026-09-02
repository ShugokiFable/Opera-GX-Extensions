(function (root) {
  'use strict';

  const API = 'https://api.nexusmods.com/v1';
  const CATEGORY_BY_ID = {
    1: 'MAIN',
    2: 'UPDATE',
    3: 'OPTIONAL',
    4: 'OLD_VERSION',
    5: 'MISCELLANEOUS',
    6: 'DELETED',
    7: 'ARCHIVED',
  };

  function positiveInt(value) {
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : null;
  }

  function parseReference(input) {
    const raw = String(input || '').trim();
    if (!raw) throw new Error('Paste a Nexus mod URL, NXM URL, or game:modId[:fileId].');

    const short = raw.match(/^([a-z0-9_-]+):(\d+)(?::(\d+))?$/i);
    if (short) {
      return {
        game: short[1].toLowerCase(),
        modId: positiveInt(short[2]),
        fileId: positiveInt(short[3]),
        key: null,
        expires: null,
      };
    }

    const nxm = raw.match(/^nxm:\/\/([^/]+)\/mods\/(\d+)\/files\/(\d+)(?:\?(.*))?$/i);
    if (nxm) {
      const q = new URLSearchParams(nxm[4] || '');
      return {
        game: nxm[1].toLowerCase(),
        modId: positiveInt(nxm[2]),
        fileId: positiveInt(nxm[3]),
        key: q.get('key'),
        expires: q.get('expires'),
      };
    }

    let url;
    try {
      url = new URL(raw);
    } catch {
      throw new Error('Unrecognized reference. Use a Nexus URL, NXM URL, or game:modId[:fileId].');
    }

    if (!/(^|\.)nexusmods\.com$/i.test(url.hostname)) {
      throw new Error('That URL is not a nexusmods.com URL.');
    }

    const parts = url.pathname.split('/').filter(Boolean);
    const modsIndex = parts.findIndex((p) => p.toLowerCase() === 'mods');
    if (modsIndex < 1 || !parts[modsIndex + 1]) {
      throw new Error('Could not find a Nexus game domain and mod ID in that URL.');
    }

    const game = parts[modsIndex - 1].toLowerCase();
    const modId = positiveInt(parts[modsIndex + 1]);
    if (!modId) throw new Error('Invalid Nexus mod ID.');

    const fileId = positiveInt(url.searchParams.get('file_id'));
    return { game, modId, fileId, key: null, expires: null };
  }

  function baseFor(ref) {
    if (!ref || !ref.game || !positiveInt(ref.modId)) throw new Error('Invalid Nexus reference.');
    return `${API}/games/${encodeURIComponent(ref.game)}/mods/${positiveInt(ref.modId)}`;
  }

  function filesUrl(ref, category) {
    const base = `${baseFor(ref)}/files.json`;
    return category == null ? base : `${base}?category=${encodeURIComponent(category)}`;
  }

  function fileInfoUrl(ref, fileId) {
    const fid = positiveInt(fileId || ref.fileId);
    if (!fid) throw new Error('A file ID is required.');
    return `${baseFor(ref)}/files/${fid}.json`;
  }

  function downloadLinkUrl(ref, fileId) {
    const fid = positiveInt(fileId || ref.fileId);
    if (!fid) throw new Error('A file ID is required.');
    const url = new URL(`${baseFor(ref)}/files/${fid}/download_link.json`);
    if (ref.key && ref.expires) {
      url.searchParams.set('key', ref.key);
      url.searchParams.set('expires', ref.expires);
    }
    return url.toString();
  }

  function websiteFileUrl(ref, fileId, useNxm) {
    const fid = positiveInt(fileId || ref.fileId);
    if (!fid) throw new Error('A file ID is required.');
    const url = new URL(`https://www.nexusmods.com/${encodeURIComponent(ref.game)}/mods/${positiveInt(ref.modId)}`);
    url.searchParams.set('tab', 'files');
    url.searchParams.set('file_id', String(fid));
    url.searchParams.set('nmm', useNxm ? '1' : '0');
    return url.toString();
  }

  function normalizeCategory(categoryName, categoryId) {
    const named = String(categoryName || '').trim().toUpperCase().replace(/\s+/g, '_');
    if (named) {
      if (named === 'OLD') return 'OLD_VERSION';
      if (named === 'REMOVED') return 'DELETED';
      return named;
    }
    return CATEGORY_BY_ID[Number(categoryId)] || 'UNKNOWN';
  }

  function normalizeFile(raw) {
    const r = raw || {};
    const fileId = positiveInt(r.file_id ?? r.fileId ?? r.id);
    const categoryId = Number(r.category_id ?? r.categoryId ?? 0) || null;
    const status = normalizeCategory(r.category_name ?? r.categoryName ?? r.category, categoryId);
    const uploadedTimestamp = Number(r.uploaded_timestamp ?? r.uploadedTimestamp ?? r.date ?? 0) || 0;
    return {
      fileId,
      name: String(r.name || r.file_name || r.fileName || (fileId ? `File ${fileId}` : 'Unknown file')),
      fileName: String(r.file_name ?? r.fileName ?? ''),
      version: String(r.version ?? r.mod_version ?? r.modVersion ?? ''),
      description: String(r.description ?? ''),
      categoryId,
      status,
      sizeKb: Number(r.size_kb ?? r.size ?? 0) || 0,
      uploadedTimestamp,
      raw: r,
    };
  }

  function richness(file) {
    return (file.name ? 2 : 0) + (file.fileName ? 3 : 0) + (file.version ? 1 : 0) +
      (file.description ? 1 : 0) + (file.categoryId ? 1 : 0) + (file.uploadedTimestamp ? 1 : 0);
  }

  function mergeFiles(...lists) {
    const map = new Map();
    for (const list of lists) {
      if (!Array.isArray(list)) continue;
      for (const item of list) {
        const f = item && item.raw !== undefined ? item : normalizeFile(item);
        if (!f.fileId) continue;
        const prev = map.get(f.fileId);
        if (!prev) {
          map.set(f.fileId, f);
          continue;
        }
        const preferred = richness(f) >= richness(prev) ? f : prev;
        const other = preferred === f ? prev : f;
        map.set(f.fileId, {
          ...other,
          ...preferred,
          name: preferred.name || other.name,
          fileName: preferred.fileName || other.fileName,
          version: preferred.version || other.version,
          description: preferred.description || other.description,
          status: preferred.status !== 'UNKNOWN' ? preferred.status : other.status,
          categoryId: preferred.categoryId || other.categoryId,
          uploadedTimestamp: Math.max(preferred.uploadedTimestamp || 0, other.uploadedTimestamp || 0),
          raw: preferred.raw || other.raw,
        });
      }
    }
    return Array.from(map.values());
  }

  const STATUS_RANK = {
    ARCHIVED: 0,
    DELETED: 1,
    OLD_VERSION: 2,
    OPTIONAL: 3,
    UPDATE: 4,
    MAIN: 5,
    MISCELLANEOUS: 6,
    UNKNOWN: 7,
  };

  function sortInteresting(files) {
    return (files || []).slice().sort((a, b) => {
      const ra = STATUS_RANK[a.status] ?? 50;
      const rb = STATUS_RANK[b.status] ?? 50;
      if (ra !== rb) return ra - rb;
      return (b.uploadedTimestamp || 0) - (a.uploadedTimestamp || 0) || (b.fileId || 0) - (a.fileId || 0);
    });
  }

  function interestingOnly(files) {
    const wanted = new Set(['ARCHIVED', 'DELETED', 'OLD_VERSION']);
    return sortInteresting((files || []).filter((f) => wanted.has(f.status)));
  }

  function errorMessage(err) {
    const status = Number(err && err.status) || 0;
    const data = err && err.data;
    let message = '';
    if (typeof data === 'string') message = data.trim();
    else if (data && typeof data === 'object') message = String(data.message || data.error || data.detail || '').trim();
    if (!message && err && err.message) message = String(err.message).trim();
    if (!message) message = status ? `Nexus API request failed (HTTP ${status})` : 'Nexus API request failed.';
    if (status && !message.includes(`HTTP ${status}`)) message += ` (HTTP ${status})`;
    return message;
  }

  function formatSize(sizeKb) {
    const bytes = Math.max(0, Number(sizeKb) || 0) * 1024;
    if (!bytes) return '';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let i = 0;
    while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
    return `${value >= 10 || i === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[i]}`;
  }

  function displayStatus(file, warnings) {
    const status = String(file && file.status || file || 'UNKNOWN').toUpperCase();
    if (status === 'ARCHIVED' || status === 'DELETED' || status === 'OLD_VERSION') return status;
    if (['MAIN', 'UPDATE', 'OPTIONAL', 'MISCELLANEOUS'].includes(status)) return 'AVAILABLE';
    const warningText = (warnings || []).join(' ').toLowerCase();
    if (status === 'UNKNOWN' && /(mod not available|hidden|not found|unavailable)/.test(warningText)) return 'HIDDEN';
    return 'UNKNOWN';
  }

  function formatDate(timestamp) {
    const value = Number(timestamp) || 0;
    if (!value) return '';
    const d = new Date(value * 1000);
    if (Number.isNaN(d.getTime())) return '';
    return d.toISOString().slice(0, 10);
  }

  function referenceLabel(ref) {
    if (!ref || !ref.game || !positiveInt(ref.modId)) return '';
    const base = `${String(ref.game).toLowerCase()}:${positiveInt(ref.modId)}`;
    const fid = positiveInt(ref.fileId);
    return fid ? `${base}:${fid}` : base;
  }

  function mergeHistory(entries, entry, limit) {
    const max = Math.max(1, Number(limit) || 12);
    const next = entry && entry.reference ? entry : null;
    const out = [];
    if (next) out.push(next);
    for (const item of Array.isArray(entries) ? entries : []) {
      if (!item || !item.reference) continue;
      if (next && item.reference === next.reference) continue;
      if (out.some((x) => x.reference === item.reference)) continue;
      out.push(item);
      if (out.length >= max) break;
    }
    return out.slice(0, max);
  }

  root.NexusArchiveCore = Object.freeze({
    API,
    CATEGORY_BY_ID,
    parseReference,
    filesUrl,
    fileInfoUrl,
    downloadLinkUrl,
    websiteFileUrl,
    normalizeCategory,
    normalizeFile,
    mergeFiles,
    sortInteresting,
    interestingOnly,
    errorMessage,
    formatSize,
    displayStatus,
    formatDate,
    referenceLabel,
    mergeHistory,
  });
})(globalThis);

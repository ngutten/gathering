// config.js — Environment detection and URL helpers

export const isTauri = typeof window !== 'undefined' && !!(window.__TAURI__ || window.__TAURI_INTERNALS__);

/// Client protocol version — must match PROTOCOL_VERSION in protocol.rs
export const CLIENT_PROTOCOL_VERSION = 1;

function getServerBase() {
  if (isTauri) {
    // Use storage module if available, fall back to direct localStorage
    // (storage.js may not be loaded yet during initial config.js import)
    if (window.gatheringStorage) {
      return window.gatheringStorage.getActiveServer();
    }
    return localStorage.getItem('gathering_active_server') || localStorage.getItem('gathering_server_url') || '';
  }
  return '';
}

export function apiUrl(path) {
  return getServerBase() + path;
}

export function fileUrl(path) {
  const base = getServerBase() + path;
  // Append auth token for authenticated file downloads
  let token;
  if (window.gatheringStorage) {
    token = window.gatheringStorage.scopedGet('token');
  } else {
    token = localStorage.getItem('gathering_token');
  }
  if (token) {
    const sep = base.includes('?') ? '&' : '?';
    return base + sep + 'token=' + encodeURIComponent(token);
  }
  return base;
}

export function wsUrl() {
  const base = getServerBase();
  if (base) {
    // Convert http(s) URL to ws(s)
    return base.replace(/^http/, 'ws') + '/ws';
  }
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws`;
}

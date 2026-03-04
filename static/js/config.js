// config.js — Environment detection and URL helpers

export const isTauri = typeof window !== 'undefined' && !!(window.__TAURI__ || window.__TAURI_INTERNALS__);

function getServerBase() {
  if (isTauri) {
    return localStorage.getItem('gathering_server_url') || '';
  }
  return '';
}

export function apiUrl(path) {
  return getServerBase() + path;
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

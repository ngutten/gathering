// storage.js — Per-server localStorage scoping for multi-server support
//
// Scoped keys use the format: gathering@host:keyname
// Global keys remain unchanged (e.g. gathering_server_history, widget:radio:volume)

import { isTauri } from './config.js';

let _currentScope = null;

/** Derive scope key from server URL: hostname:port (or just hostname if default port) */
function scopeFromUrl(url) {
  try {
    const u = new URL(url);
    // Use host (includes port if non-default)
    return u.host;
  } catch {
    return url;
  }
}

/** Get the current server scope string */
export function getServerScope() {
  if (_currentScope) return _currentScope;
  if (isTauri) {
    const url = localStorage.getItem('gathering_active_server') || '';
    _currentScope = url ? scopeFromUrl(url) : '';
  } else {
    _currentScope = location.host;
  }
  return _currentScope;
}

function scopedKey(key) {
  const scope = getServerScope();
  if (!scope) return 'gathering_' + key;
  return `gathering@${scope}:${key}`;
}

// ── Scoped storage (per-server) ──

export function scopedGet(key) {
  return localStorage.getItem(scopedKey(key));
}

export function scopedSet(key, val) {
  localStorage.setItem(scopedKey(key), val);
}

export function scopedRemove(key) {
  localStorage.removeItem(scopedKey(key));
}

/** Iterate all scoped keys matching a prefix, returning { suffix, value } pairs */
export function scopedEntries(prefix) {
  const fullPrefix = scopedKey(prefix);
  const results = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(fullPrefix)) {
      const suffix = k.substring(fullPrefix.length);
      results.push({ suffix, value: localStorage.getItem(k) });
    }
  }
  return results;
}

// ── Global storage (not per-server) ──

export function globalGet(key) {
  return localStorage.getItem(key);
}

export function globalSet(key, val) {
  localStorage.setItem(key, val);
}

export function globalRemove(key) {
  localStorage.removeItem(key);
}

// ── Active server management ──

export function getActiveServer() {
  return localStorage.getItem('gathering_active_server') || '';
}

export function setActiveServer(url) {
  const cleaned = url.trim().replace(/\/$/, '');
  localStorage.setItem('gathering_active_server', cleaned);
  _currentScope = cleaned ? scopeFromUrl(cleaned) : '';
}

// ── Server history ──

export function getServerHistory() {
  try {
    return JSON.parse(localStorage.getItem('gathering_server_history') || '[]');
  } catch { return []; }
}

export function addServerToHistory(url) {
  const cleaned = url.trim().replace(/\/$/, '');
  const history = getServerHistory().filter(u => u !== cleaned);
  history.unshift(cleaned);
  localStorage.setItem('gathering_server_history', JSON.stringify(history));
}

export function removeServerFromHistory(url) {
  const history = getServerHistory().filter(u => u !== url);
  localStorage.setItem('gathering_server_history', JSON.stringify(history));
}

/** Delete all scoped keys for a given server URL */
export function removeServerData(url) {
  const scope = scopeFromUrl(url);
  const prefix = `gathering@${scope}:`;
  const toRemove = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(prefix)) toRemove.push(k);
  }
  toRemove.forEach(k => localStorage.removeItem(k));
}

/** Check if a server has a stored token */
export function serverHasToken(url) {
  const scope = scopeFromUrl(url);
  return !!localStorage.getItem(`gathering@${scope}:token`);
}

// ── Migration from legacy unscoped keys ──

const LEGACY_SCOPED_KEYS = [
  'gathering_token',
  'gathering_e2e_sk',
  'gathering_e2e_pk',
  'gathering_pinned_keys',
  'gathering_key_denials',
];

export function runMigration() {
  if (localStorage.getItem('gathering_migration_v2')) return;

  // Determine the server to scope legacy keys to
  let serverUrl = localStorage.getItem('gathering_server_url') || '';
  if (!isTauri && !serverUrl) {
    // Browser mode: scope to current host
    serverUrl = location.origin;
  }
  if (!serverUrl) {
    // No server configured yet — nothing to migrate
    localStorage.setItem('gathering_migration_v2', '1');
    return;
  }

  const scope = scopeFromUrl(serverUrl);

  // Migrate known scoped keys
  for (const legacyKey of LEGACY_SCOPED_KEYS) {
    const val = localStorage.getItem(legacyKey);
    if (val !== null) {
      const newKey = `gathering@${scope}:${legacyKey.replace('gathering_', '')}`;
      localStorage.setItem(newKey, val);
      localStorage.removeItem(legacyKey);
    }
  }

  // Migrate last_read_* keys
  const lastReadKeys = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith('gathering_last_read_')) lastReadKeys.push(k);
  }
  for (const k of lastReadKeys) {
    const channel = k.substring('gathering_last_read_'.length);
    const val = localStorage.getItem(k);
    if (val !== null) {
      localStorage.setItem(`gathering@${scope}:last_read_${channel}`, val);
      localStorage.removeItem(k);
    }
  }

  // Rename gathering_server_url → gathering_active_server
  if (localStorage.getItem('gathering_server_url')) {
    localStorage.setItem('gathering_active_server', localStorage.getItem('gathering_server_url'));
    localStorage.removeItem('gathering_server_url');
  }

  localStorage.setItem('gathering_migration_v2', '1');
}

// ── Auto-run migration on module load ──
runMigration();

// ── Expose on window for classic scripts (tauri-bridge.js) ──
window.gatheringStorage = {
  scopedGet, scopedSet, scopedRemove, scopedEntries,
  globalGet, globalSet, globalRemove,
  getActiveServer, setActiveServer, getServerScope,
  getServerHistory, addServerToHistory, removeServerFromHistory,
  removeServerData, serverHasToken,
  runMigration,
};

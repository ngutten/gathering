// transport.js — WebSocket wrapper and API fetch

import { wsUrl, apiUrl, CLIENT_PROTOCOL_VERSION } from './config.js';
import state, { emit } from './state.js';

const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 60000;
let reconnectAttempts = 0;
let reconnectTimer = null;
let pongTimer = null;

// Connection states: 'disconnected' | 'connecting' | 'connected'
let connectionState = 'disconnected';

function setConnectionState(s) {
  if (connectionState === s) return;
  connectionState = s;
  emit('connection-state', s);
}

export function getConnectionState() { return connectionState; }

export function connectWS() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (state.ws && (state.ws.readyState === WebSocket.OPEN || state.ws.readyState === WebSocket.CONNECTING)) {
    return; // already connected or connecting
  }

  setConnectionState('connecting');
  state.ws = new WebSocket(wsUrl());

  state.ws.onopen = () => {
    state.ws.send(JSON.stringify({ type: 'Auth', token: state.token, protocol_version: CLIENT_PROTOCOL_VERSION }));
    reconnectAttempts = 0;
    setConnectionState('connected');
    resetPongTimer();
  };

  state.ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (!msg || !msg.type) {
        console.warn('WS message missing type:', msg);
        return;
      }
      emit('server-message', msg);
    } catch (err) {
      console.error('WS JSON parse error:', err);
    }
    // Any message from the server means the connection is alive
    resetPongTimer();
  };

  state.ws.onclose = () => {
    clearPongTimer();
    setConnectionState('disconnected');
    emit('ws-closed');
    scheduleReconnect();
  };

  state.ws.onerror = () => {
    // onclose will fire after onerror, so reconnect is handled there
  };
}

function scheduleReconnect() {
  if (!state.token) return;
  if (reconnectTimer) return;
  const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, reconnectAttempts), RECONNECT_MAX_MS);
  // Add jitter: +/- 20%
  const jitter = delay * (0.8 + Math.random() * 0.4);
  reconnectAttempts++;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (state.token) connectWS();
  }, jitter);
}

// Pong watchdog: if we don't receive any WS data within 45s, reconnect
function resetPongTimer() {
  clearPongTimer();
  pongTimer = setTimeout(() => {
    console.warn('[ws] No data from server in 45s, reconnecting...');
    if (state.ws) {
      state.ws.onclose = null;
      state.ws.close();
      state.ws = null;
    }
    setConnectionState('disconnected');
    emit('ws-closed');
    reconnectAttempts = 0; // immediate reconnect on timeout
    scheduleReconnect();
  }, 45000);
}

function clearPongTimer() {
  if (pongTimer) { clearTimeout(pongTimer); pongTimer = null; }
}

// Visibility change: reconnect immediately when page becomes visible
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  if (!state.token) return;
  if (state.ws && state.ws.readyState === WebSocket.OPEN) return;
  // Page is visible again and we're not connected — reconnect now
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  reconnectAttempts = 0;
  connectWS();
});

export function send(type, payload = {}) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({ type, ...payload }));
  }
}

export async function apiFetch(path, opts = {}) {
  const url = apiUrl(path);
  if (state.token) {
    opts.headers = { ...opts.headers, 'Authorization': `Bearer ${state.token}` };
  }
  return fetch(url, opts);
}

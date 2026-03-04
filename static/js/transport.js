// transport.js — WebSocket wrapper and API fetch

import { wsUrl, apiUrl } from './config.js';
import state, { emit } from './state.js';

const RECONNECT_DELAY_MS = 3000;

export function connectWS() {
  state.ws = new WebSocket(wsUrl());

  state.ws.onopen = () => {
    state.ws.send(JSON.stringify({ type: 'Auth', token: state.token }));
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
  };

  state.ws.onclose = () => {
    emit('ws-closed');
    setTimeout(() => { if (state.token) connectWS(); }, RECONNECT_DELAY_MS);
  };
}

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

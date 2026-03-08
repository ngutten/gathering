// auth.js — Login, register, server info check

import state from './state.js';
import { apiUrl } from './config.js';
import { connectWS } from './transport.js';
import { apiFetch } from './transport.js';
import { scopedSet, scopedRemove } from './storage.js';

export async function checkServerInfo() {
  try {
    const res = await fetch(apiUrl('/api/server-info'));
    const data = await res.json();
    const regMode = data.registration_mode || 'open';
    const regBtn = document.getElementById('register-btn');
    const inviteInput = document.getElementById('invite-code');
    if (regMode === 'closed') {
      regBtn.style.display = 'none';
      inviteInput.style.display = 'none';
    } else if (regMode === 'invite') {
      regBtn.style.display = '';
      inviteInput.style.display = '';
    } else {
      regBtn.style.display = '';
      inviteInput.style.display = 'none';
    }
    // Store server branding for use by tauri-bridge and UI
    state.serverName = data.server_name || null;
    state.serverIcon = data.server_icon || null;
    // Update auth screen server info if available
    if (window._updateAuthServerInfo) window._updateAuthServerInfo();
    // Update server rail icon if available
    if (window._renderServerRail) window._renderServerRail();
  } catch (e) {}
}

export async function doAuth(endpoint) {
  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value;
  const errEl = document.getElementById('auth-error');
  errEl.textContent = '';

  if (!username || !password) { errEl.textContent = 'Fill in both fields'; return; }

  const body = { username, password };
  const inviteCode = document.getElementById('invite-code').value.trim();
  if (inviteCode && endpoint === 'register') {
    body.invite_code = inviteCode;
  }

  try {
    const res = await fetch(apiUrl(`/api/${endpoint}`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (data.ok && data.token) {
      state.token = data.token;
      scopedSet('token', data.token);
      connectWS();
    } else {
      errEl.textContent = data.error || 'Auth failed';
    }
  } catch (e) {
    errEl.textContent = 'Connection error: ' + e.message;
  }
}

export function doLogin() { doAuth('login'); }
export function doRegister() { doAuth('register'); }

export async function doLogout() {
  // S4: Server-side logout
  try {
    await apiFetch('/api/logout', { method: 'POST' });
  } catch (e) {}
  scopedRemove('token');
  state.token = null;
  if (state.ws) {
    state.ws.onclose = null; // prevent auto-reconnect
    state.ws.close();
    state.ws = null;
  }
  document.getElementById('chat-screen').style.display = 'none';
  document.getElementById('auth-screen').style.display = 'flex';
  document.getElementById('password').value = '';
}

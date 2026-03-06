// crypto.js — E2E encryption: key management, encrypt/decrypt, key approval UI

import state, { emit } from './state.js';
import { send } from './transport.js';
import { escapeHtml } from './render.js';

export async function initE2E() {
  // Wait for libsodium to be loaded by the shim
  while (typeof sodium === 'undefined' || !sodium.ready) {
    await new Promise(r => setTimeout(r, 100));
  }
  await sodium.ready;
  // Load existing X25519 keypair — do NOT auto-generate
  const storedSk = localStorage.getItem('gathering_e2e_sk');
  const storedPk = localStorage.getItem('gathering_e2e_pk');
  if (storedSk && storedPk) {
    state.myKeyPair = {
      privateKey: sodium.from_base64(storedSk),
      publicKey: sodium.from_base64(storedPk),
    };
    state.e2eReady = true;
    send('UploadPublicKey', { public_key: sodium.to_base64(state.myKeyPair.publicKey) });
  }
  // If no key exists, user must explicitly generate or import one
  updateKeyUI();
}

/** Generate a new E2E keypair. Returns false if one already exists (caller should confirm overwrite). */
export function generateE2EKey(force) {
  if (state.myKeyPair && !force) return false;
  const kp = sodium.crypto_box_keypair();
  state.myKeyPair = { publicKey: kp.publicKey, privateKey: kp.privateKey };
  localStorage.setItem('gathering_e2e_sk', sodium.to_base64(kp.privateKey));
  localStorage.setItem('gathering_e2e_pk', sodium.to_base64(kp.publicKey));
  state.e2eReady = true;
  state.channelKeys = {};
  send('UploadPublicKey', { public_key: sodium.to_base64(kp.publicKey) });
  updateKeyUI();
  emit('system-message', 'E2E keypair generated. Export your key from the sidebar to back it up. If lost, encrypted history cannot be recovered.');
  return true;
}

export function generateChannelKey() {
  return sodium.crypto_aead_xchacha20poly1305_ietf_keygen();
}

export function encryptMessage(plaintext, channelKey) {
  const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const encoder = new TextEncoder();
  const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    encoder.encode(plaintext), null, null, nonce, channelKey
  );
  const payload = new Uint8Array(1 + nonce.length + ciphertext.length);
  payload[0] = 0x01;
  payload.set(nonce, 1);
  payload.set(ciphertext, 1 + nonce.length);
  return sodium.to_base64(payload);
}

export function decryptMessage(base64Payload, channelKey) {
  try {
    const payload = sodium.from_base64(base64Payload);
    if (payload[0] !== 0x01) return null;
    const nonce = payload.slice(1, 1 + sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
    const ciphertext = payload.slice(1 + sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
    const plainBytes = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null, ciphertext, null, nonce, channelKey
    );
    return new TextDecoder().decode(plainBytes);
  } catch (e) {
    return null;
  }
}

/** Encrypt content for a channel if a key is available. Returns { content, encrypted }. */
export function tryEncrypt(content, channel) {
  const key = state.channelKeys[channel];
  if (key && content) {
    return { content: encryptMessage(content, key), encrypted: true };
  }
  return { content, encrypted: false };
}

/** Decrypt content from a channel. Returns decrypted string, or a placeholder on failure. */
export function tryDecrypt(content, channel) {
  const key = state.channelKeys[channel];
  if (!key) return '[Encrypted - key unavailable]';
  const dec = decryptMessage(content, key);
  return dec !== null ? dec : '[Encrypted - decryption failed]';
}

export function encryptChannelKeyForUser(channelKey, recipientPubKeyBase64) {
  const recipientPk = sodium.from_base64(recipientPubKeyBase64);
  const sealed = sodium.crypto_box_seal(channelKey, recipientPk);
  return sodium.to_base64(sealed);
}

export function decryptChannelKey(encryptedKeyBase64) {
  try {
    const sealed = sodium.from_base64(encryptedKeyBase64);
    return sodium.crypto_box_seal_open(sealed, state.myKeyPair.publicKey, state.myKeyPair.privateKey);
  } catch (e) {
    return null;
  }
}

export function getKeyFingerprint() {
  if (!state.myKeyPair) return '';
  const hash = sodium.crypto_generichash(32, state.myKeyPair.publicKey);
  return sodium.to_hex(hash).substring(0, 16);
}

export function exportPrivateKey() {
  if (!state.myKeyPair) return;
  const data = JSON.stringify({
    sk: sodium.to_base64(state.myKeyPair.privateKey),
    pk: sodium.to_base64(state.myKeyPair.publicKey),
  });
  const blob = new Blob([data], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `gathering-key-${state.currentUser}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

export function importPrivateKey() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json';
  input.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const text = await file.text();
    try {
      const data = JSON.parse(text);
      const sk = sodium.from_base64(data.sk);
      const pk = sodium.from_base64(data.pk);
      state.myKeyPair = { privateKey: sk, publicKey: pk };
      state.e2eReady = true;
      localStorage.setItem('gathering_e2e_sk', data.sk);
      localStorage.setItem('gathering_e2e_pk', data.pk);
      send('UploadPublicKey', { public_key: data.pk });
      emit('system-message', 'Key imported successfully. Re-request channel keys to decrypt history.');
      state.channelKeys = {};
      updateKeyUI();
    } catch (err) {
      emit('system-message', 'Failed to import key: ' + err.message);
    }
  };
  input.click();
}

export function updateKeyUI() {
  const fp = document.getElementById('key-fingerprint');
  const noKeyLabel = document.getElementById('no-key-label');
  const hasKeySection = document.getElementById('e2e-has-key');
  const noKeySection = document.getElementById('e2e-no-key');
  const hasKey = !!state.myKeyPair;
  if (fp) fp.textContent = hasKey ? getKeyFingerprint() : '';
  if (noKeyLabel) noKeyLabel.style.display = hasKey ? 'none' : '';
  if (hasKeySection) hasKeySection.style.display = hasKey ? '' : 'none';
  if (noKeySection) noKeySection.style.display = hasKey ? 'none' : '';
  // Update channel list styling for encrypted channels
  renderEncryptedChannelStates();
}

/** Re-render channel/DM lists to pick up no-e2e-key styling changes */
function renderEncryptedChannelStates() {
  // The renderChannels/renderDMList functions in chat-ui.js apply the class,
  // so we just need to trigger a re-render if those elements exist.
  // Avoid circular import — directly toggle classes on existing elements.
  document.querySelectorAll('.channel-item, .dm-item').forEach(el => {
    const onclick = el.getAttribute('onclick') || '';
    const match = onclick.match(/switchChannel\('([^']+)'\)/);
    if (match && state.encryptedChannels.has(match[1])) {
      el.classList.toggle('no-e2e-key', !state.e2eReady);
    }
  });
}

// Deny cooldown: suppress repeated key requests from the same user+channel
const DENY_COOLDOWN_KEY = 'gathering_key_denials';
const DEFAULT_DENY_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 1 day

function getDenials() {
  try {
    return JSON.parse(localStorage.getItem(DENY_COOLDOWN_KEY) || '{}');
  } catch { return {}; }
}

function setDenial(channel, user) {
  const denials = getDenials();
  denials[`${channel}:${user}`] = Date.now();
  localStorage.setItem(DENY_COOLDOWN_KEY, JSON.stringify(denials));
}

function isDenied(channel, user) {
  const denials = getDenials();
  const ts = denials[`${channel}:${user}`];
  if (!ts) return false;
  const cooldown = parseInt(localStorage.getItem('gathering_deny_cooldown_ms') || DEFAULT_DENY_COOLDOWN_MS, 10);
  if (Date.now() - ts < cooldown) return true;
  // Expired — clean up
  delete denials[`${channel}:${user}`];
  localStorage.setItem(DENY_COOLDOWN_KEY, JSON.stringify(denials));
  return false;
}

export function showKeyApproval(channel, user, publicKey) {
  if (state.pendingKeyRequests.some(r => r.channel === channel && r.user === user)) return;
  if (isDenied(channel, user)) return;
  state.pendingKeyRequests.push({ channel, user, publicKey });
  renderKeyRequests();
}

export function approveKeyRequest(index) {
  const req = state.pendingKeyRequests[index];
  if (!req || !state.channelKeys[req.channel]) return;
  const sealed = encryptChannelKeyForUser(state.channelKeys[req.channel], req.publicKey);
  send('ProvideChannelKey', {
    channel: req.channel,
    target_user: req.user,
    encrypted_key: sealed,
  });
  state.publicKeyCache[req.user] = req.publicKey;
  state.pendingKeyRequests.splice(index, 1);
  renderKeyRequests();
  emit('system-message', `Granted ${req.user} access to #${req.channel}`);
}

export function denyKeyRequest(index) {
  const req = state.pendingKeyRequests[index];
  state.pendingKeyRequests.splice(index, 1);
  renderKeyRequests();
  if (req) {
    setDenial(req.channel, req.user);
    emit('system-message', `Denied ${req.user} access to #${req.channel} (suppressed for 24h)`);
  }
}

export function renderKeyRequests() {
  let el = document.getElementById('key-requests');
  if (!el) {
    el = document.createElement('div');
    el.id = 'key-requests';
    const sidebar = document.querySelector('.sidebar');
    const bottom = sidebar.querySelector('.sidebar-bottom');
    sidebar.insertBefore(el, bottom);
  }
  if (state.pendingKeyRequests.length === 0) {
    el.innerHTML = '';
    return;
  }
  el.innerHTML = '<div style="padding:0.3rem 1rem;border-top:1px solid var(--border);border-bottom:1px solid var(--border);">' +
    '<div style="font-size:0.7rem;text-transform:uppercase;color:var(--orange);letter-spacing:0.05em;margin-bottom:0.3rem;">Key Requests</div>' +
    state.pendingKeyRequests.map((r, i) =>
      `<div style="font-size:0.75rem;margin-bottom:0.4rem;padding:0.3rem;background:var(--bg);border:1px solid var(--border);border-radius:4px;">` +
      `<div><strong>${escapeHtml(r.user)}</strong> wants access to <strong>#${escapeHtml(r.channel)}</strong></div>` +
      `<div style="display:flex;gap:0.3rem;margin-top:0.2rem;">` +
      `<button onclick="approveKeyRequest(${i})" style="padding:0.15rem 0.4rem;background:var(--green);color:#000;border:none;border-radius:3px;cursor:pointer;font-family:inherit;font-size:0.7rem;">Approve</button>` +
      `<button onclick="denyKeyRequest(${i})" style="padding:0.15rem 0.4rem;background:var(--red);color:#fff;border:none;border-radius:3px;cursor:pointer;font-family:inherit;font-size:0.7rem;">Deny</button>` +
      `</div></div>`
    ).join('') +
    '</div>';
}

export function encryptFile(arrayBuffer, channelKey) {
  const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const plainBytes = new Uint8Array(arrayBuffer);
  const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    plainBytes, null, null, nonce, channelKey
  );
  const payload = new Uint8Array(1 + nonce.length + ciphertext.length);
  payload[0] = 0x02; // file prefix (distinct from 0x01 message prefix)
  payload.set(nonce, 1);
  payload.set(ciphertext, 1 + nonce.length);
  return payload;
}

export function decryptFile(uint8Array, channelKey) {
  try {
    if (uint8Array[0] !== 0x02) return null;
    const nonceLen = sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES;
    const nonce = uint8Array.slice(1, 1 + nonceLen);
    const ciphertext = uint8Array.slice(1 + nonceLen);
    const plainBytes = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null, ciphertext, null, nonce, channelKey
    );
    return plainBytes.buffer;
  } catch (e) {
    return null;
  }
}

/** Manual re-key: generates a new channel key and distributes to all cached members.
 *  WARNING: old messages become unreadable. Callers must confirm with the user first. */
export async function rekeyChannel(channel) {
  if (!state.e2eReady || !state.channelKeys[channel]) return;
  const newKey = generateChannelKey();
  state.channelKeys[channel] = newKey;
  const newKeys = {};
  newKeys[state.currentUser] = encryptChannelKeyForUser(newKey, sodium.to_base64(state.myKeyPair.publicKey));
  for (const [user, pk] of Object.entries(state.publicKeyCache)) {
    if (user !== state.currentUser) {
      newKeys[user] = encryptChannelKeyForUser(newKey, pk);
    }
  }
  send('RotateChannelKey', { channel, new_keys: newKeys });
}

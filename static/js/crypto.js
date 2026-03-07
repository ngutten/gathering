// crypto.js — E2E encryption: key management, encrypt/decrypt, key approval UI

import state, { emit } from './state.js';
import { send } from './transport.js';
import { escapeHtml } from './render.js';

// ── TOFU (Trust On First Use) public key pinning ────────────────────
// Stores known user→publicKey mappings in localStorage.
// On first contact, the key is pinned. If a different key is later seen
// for the same user, the client warns and blocks key sharing.
const PINNED_KEYS_STORAGE = 'gathering_pinned_keys';

function loadPinnedKeys() {
  try { return JSON.parse(localStorage.getItem(PINNED_KEYS_STORAGE) || '{}'); }
  catch { return {}; }
}

function savePinnedKeys(pins) {
  localStorage.setItem(PINNED_KEYS_STORAGE, JSON.stringify(pins));
}

/** Pin a public key for a user (TOFU). Returns true if OK, false if conflict. */
export function pinPublicKey(username, publicKey) {
  const pins = loadPinnedKeys();
  if (pins[username] && pins[username] !== publicKey) {
    return false; // key changed — conflict
  }
  if (!pins[username]) {
    pins[username] = publicKey;
    savePinnedKeys(pins);
  }
  return true;
}

/** Check a public key against the pinned key. Returns 'ok', 'new', or 'mismatch'. */
export function checkPinnedKey(username, publicKey) {
  const pins = loadPinnedKeys();
  if (!pins[username]) return 'new';
  return pins[username] === publicKey ? 'ok' : 'mismatch';
}

/** Get the pinned public key for a user, or null. */
export function getPinnedKey(username) {
  return loadPinnedKeys()[username] || null;
}

/** Remove a pinned key (for manual trust reset). */
export function unpinKey(username) {
  const pins = loadPinnedKeys();
  delete pins[username];
  savePinnedKeys(pins);
}

/** Compute a short hex fingerprint from a base64 public key string. */
export function fingerprintFromBase64(pubKeyBase64) {
  const raw = sodium.from_base64(pubKeyBase64);
  const hash = sodium.crypto_generichash(32, raw);
  return sodium.to_hex(hash).substring(0, 16);
}

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
  const pkB64 = sodium.to_base64(kp.publicKey);
  send('UploadPublicKey', { public_key: pkB64 });
  // Pin our own key
  if (state.currentUser) pinPublicKey(state.currentUser, pkB64);
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
      // Pin our own key (overwrite any previous pin since this is an explicit import)
      if (state.currentUser) {
        unpinKey(state.currentUser);
        pinPublicKey(state.currentUser, data.pk);
      }
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

  // TOFU check: does this key match what we've pinned for this user?
  const tofuStatus = checkPinnedKey(user, publicKey);
  state.pendingKeyRequests.push({ channel, user, publicKey, tofuStatus });
  renderKeyRequests();
}

export function approveKeyRequest(index) {
  const req = state.pendingKeyRequests[index];
  if (!req || !state.channelKeys[req.channel]) return;

  // Pin this user's public key on approval (TOFU)
  pinPublicKey(req.user, req.publicKey);

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
    state.pendingKeyRequests.map((r, i) => {
      const fp = fingerprintFromBase64(r.publicKey);
      const isMismatch = r.tofuStatus === 'mismatch';
      const isNew = r.tofuStatus === 'new';
      const borderColor = isMismatch ? 'var(--red)' : 'var(--border)';
      let warning = '';
      if (isMismatch) {
        warning = `<div style="color:var(--red);font-weight:bold;font-size:0.7rem;margin-top:0.2rem;">` +
          `WARNING: Key does not match previously known key for this user!</div>`;
      } else if (isNew) {
        warning = `<div style="color:var(--orange);font-size:0.65rem;margin-top:0.1rem;">First time seeing this user's key</div>`;
      }
      return `<div style="font-size:0.75rem;margin-bottom:0.4rem;padding:0.3rem;background:var(--bg);border:1px solid ${borderColor};border-radius:4px;">` +
        `<div><strong>${escapeHtml(r.user)}</strong> wants access to <strong>#${escapeHtml(r.channel)}</strong></div>` +
        `<div style="font-size:0.6rem;color:var(--muted);margin-top:0.1rem;font-family:monospace;">Key: ${escapeHtml(fp)}</div>` +
        warning +
        `<div style="display:flex;gap:0.3rem;margin-top:0.2rem;">` +
        (isMismatch
          ? `<button onclick="approveKeyRequest(${i})" style="padding:0.15rem 0.4rem;background:var(--red);color:#fff;border:none;border-radius:3px;cursor:pointer;font-family:inherit;font-size:0.7rem;" title="Key mismatch — only approve if you have verified this out-of-band">Force Approve</button>`
          : `<button onclick="approveKeyRequest(${i})" style="padding:0.15rem 0.4rem;background:var(--green);color:#000;border:none;border-radius:3px;cursor:pointer;font-family:inherit;font-size:0.7rem;">Approve</button>`) +
        `<button onclick="denyKeyRequest(${i})" style="padding:0.15rem 0.4rem;background:var(--red);color:#fff;border:none;border-radius:3px;cursor:pointer;font-family:inherit;font-size:0.7rem;">Deny</button>` +
        `</div></div>`;
    }).join('') +
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
  let skipped = 0;
  for (const [user, pk] of Object.entries(state.publicKeyCache)) {
    if (user !== state.currentUser) {
      // Only re-key to users whose public keys pass TOFU check
      const status = checkPinnedKey(user, pk);
      if (status === 'mismatch') {
        skipped++;
        continue;
      }
      newKeys[user] = encryptChannelKeyForUser(newKey, pk);
    }
  }
  send('RotateChannelKey', { channel, new_keys: newKeys });
  if (skipped > 0) {
    emit('system-message', `Key rotation: skipped ${skipped} user(s) with mismatched public keys.`);
  }
}

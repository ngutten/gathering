// input.js — Message sending, input handling, file upload, edit mode

import state, { isDMChannel } from './state.js';
import { send, apiFetch } from './transport.js';
import { encryptFile, encryptChannelKeyForUser, generateChannelKey, tryEncrypt } from './crypto.js';
import { escapeHtml, formatFileSize } from './render.js';
import { appendSystem, cancelReply } from './chat-ui.js';

const MAX_UPLOAD_SIZE = 50 * 1024 * 1024; // 50MB
const MAX_INPUT_HEIGHT_PX = 120;
const TYPING_THROTTLE_MS = 2000;

export function sendMessage() {
  const input = document.getElementById('msg-input');
  const content = input.value.trim();

  if (state.editingMessageId) {
    if (!content) return;
    const enc = tryEncrypt(content, state.currentChannel);
    send('EditMessage', { message_id: state.editingMessageId, content: enc.content });
    cancelEdit();
    return;
  }

  if (!content && state.pendingAttachments.length === 0) return;

  const ttlSelect = document.getElementById('ttl-select');
  const ttl = ttlSelect.value ? parseInt(ttlSelect.value) : null;

  const enc = tryEncrypt(content || '', state.currentChannel);

  const msg = {
    channel: state.currentChannel,
    content: enc.content,
    ttl_secs: ttl,
    encrypted: enc.encrypted,
  };

  if (state.pendingAttachments.length > 0) {
    msg.attachments = state.pendingAttachments.map(f => f.id);
  }

  if (state.replyTo) {
    msg.reply_to = state.replyTo;
    cancelReply();
  }

  send('Send', msg);
  input.value = '';
  input.style.height = 'auto';
  state.pendingAttachments = [];
  renderPendingFiles();
}

export function handleInputKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
    return;
  }
  if (e.key === 'Escape') {
    if (state.editingMessageId) { cancelEdit(); return; }
    if (state.replyTo) { cancelReply(); return; }
  }
  if (e.key === 'ArrowUp' && !state.editingMessageId) {
    const input = document.getElementById('msg-input');
    if (input.value === '') {
      const msgs = document.querySelectorAll(`.msg[data-author="${state.currentUser}"]`);
      if (msgs.length > 0) {
        const lastMsg = msgs[msgs.length - 1];
        const msgId = lastMsg.getAttribute('data-msg-id');
        if (msgId) startEditMessage(msgId);
      }
      e.preventDefault();
      return;
    }
  }
  if (e.key === 'Tab') {
    e.preventDefault();
    const ta = e.target;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    ta.value = ta.value.substring(0, start) + '  ' + ta.value.substring(end);
    ta.selectionStart = ta.selectionEnd = start + 2;
    return;
  }
  e.target.style.height = 'auto';
  e.target.style.height = Math.min(e.target.scrollHeight, MAX_INPUT_HEIGHT_PX) + 'px';

  const now = Date.now();
  if (now - state.lastTypingSent > TYPING_THROTTLE_MS) {
    state.lastTypingSent = now;
    send('Typing', { channel: state.currentChannel });
  }
}

export async function handleFileSelect(event) {
  const files = event.target.files;
  if (!files.length) return;

  const progress = document.getElementById('upload-progress');

  for (const file of files) {
    if (file.size > MAX_UPLOAD_SIZE) {
      progress.textContent = `${file.name}: too large (max 50MB)`;
      continue;
    }

    const channelKey = state.channelKeys[state.currentChannel];
    progress.textContent = channelKey ? `Encrypting & uploading ${file.name}...` : `Uploading ${file.name}...`;

    const formData = new FormData();
    if (channelKey) {
      const buf = await file.arrayBuffer();
      const encrypted = encryptFile(buf, channelKey);
      const encBlob = new Blob([encrypted], { type: 'application/octet-stream' });
      formData.append('file', new File([encBlob], file.name, { type: file.type }));
      formData.append('encrypted', 'true');
    } else {
      formData.append('file', file);
    }
    formData.append('channel', state.currentChannel);

    try {
      const res = await apiFetch('/api/upload', {
        method: 'POST',
        body: formData,
      });
      const data = await res.json();
      if (data.ok && data.file) {
        state.pendingAttachments.push(data.file);
        renderPendingFiles();
        progress.textContent = '';
      } else {
        progress.textContent = `Failed: ${data.error || 'Unknown error'}`;
      }
    } catch (e) {
      progress.textContent = `Upload failed: ${e.message}`;
    }
  }

  event.target.value = '';
}

export function renderPendingFiles() {
  const el = document.getElementById('pending-files');
  el.innerHTML = state.pendingAttachments.map((f, i) =>
    `<div class="pending-file">${escapeHtml(f.filename)} <span class="file-size">(${formatFileSize(f.size)})</span><span class="remove-file" onclick="removePendingFile(${i})">&times;</span></div>`
  ).join('');
}

export function removePendingFile(index) {
  state.pendingAttachments.splice(index, 1);
  renderPendingFiles();
}

export function startEditMessage(msgId) {
  const msgEl = document.querySelector(`.msg[data-msg-id="${msgId}"]`);
  if (!msgEl) return;
  const content = msgEl.getAttribute('data-content');
  state.editingMessageId = msgId;
  const input = document.getElementById('msg-input');
  input.value = content;
  input.focus();
  document.getElementById('edit-banner').classList.add('active');
  document.getElementById('send-btn').textContent = 'Save';
}

export function cancelEdit() {
  state.editingMessageId = null;
  document.getElementById('msg-input').value = '';
  document.getElementById('edit-banner').classList.remove('active');
  document.getElementById('send-btn').textContent = 'Send';
}

export function deleteMessage(msgId) {
  send('DeleteMessage', { message_id: msgId });
}

export function joinChannel() {
  const input = document.getElementById('new-channel');
  let name = input.value.trim().replace(/^#/, '').replace(/[^a-zA-Z0-9_-]/g, '');
  if (!name || isDMChannel(name)) return;
  const encCheck = document.getElementById('encrypted-channel-check');
  const wantEncrypted = encCheck && encCheck.checked;
  input.value = '';
  if (encCheck) encCheck.checked = false;

  if (wantEncrypted && !state.e2eReady) {
    appendSystem('Generate or import an E2E key before creating encrypted channels.');
    return;
  }
  if (wantEncrypted && state.e2eReady) {
    const chKey = generateChannelKey();
    state.channelKeys[name] = chKey;
    const sealedForSelf = encryptChannelKeyForUser(chKey, sodium.to_base64(state.myKeyPair.publicKey));
    send('CreateEncryptedChannel', { channel: name, encrypted_channel_key: sealedForSelf });
  }

  send('Join', { channel: name });
  state.currentChannel = name;
  document.getElementById('chat-channel-name').textContent = `#${name}`;
  document.getElementById('messages').innerHTML = '';
}

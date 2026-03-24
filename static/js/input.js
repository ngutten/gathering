// input.js — Message sending, input handling, file upload, edit mode

import state, { isDMChannel } from './state.js';
import { send, apiFetch } from './transport.js';
import { encryptFile, encryptChannelKeyForUser, generateChannelKey, tryEncrypt } from './crypto.js';
import { escapeHtml, formatFileSize } from './render.js';
import { appendSystem, cancelReply, getEffectiveGhostTtl } from './chat-ui.js';
import { scopedGet, scopedSet } from './storage.js';

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

  const ttl = getEffectiveGhostTtl();

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
    // Escape blurs the input so Tab can navigate freely
    e.target.blur();
    return;
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
  if (e.key === 'Tab' && e.target.value.includes('\n')) {
    // Only capture Tab for indentation when composing multi-line content
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
  await uploadFiles(files);
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

export function hideMessage(msgId) {
  const hidden = getHiddenMessages();
  hidden.add(msgId);
  saveHiddenMessages(hidden);
  const el = document.querySelector(`.msg[data-msg-id="${msgId}"]`);
  if (el) el.remove();
}

export function unhideMessage(msgId) {
  const hidden = getHiddenMessages();
  hidden.delete(msgId);
  saveHiddenMessages(hidden);
}

export function getHiddenMessages() {
  try {
    const raw = scopedGet('hidden_messages');
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch { return new Set(); }
}

function saveHiddenMessages(set) {
  scopedSet('hidden_messages', JSON.stringify([...set]));
}

// ── Drag-and-drop + paste file handling ──

export function setupDragAndDrop() {
  const chatPanel = document.querySelector('.chat-main');
  if (!chatPanel) return;

  let dragCounter = 0;

  chatPanel.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragCounter++;
    if (dragCounter === 1) chatPanel.classList.add('drop-active');
  });

  chatPanel.addEventListener('dragleave', (e) => {
    e.preventDefault();
    dragCounter--;
    if (dragCounter === 0) chatPanel.classList.remove('drop-active');
  });

  chatPanel.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });

  chatPanel.addEventListener('drop', (e) => {
    e.preventDefault();
    dragCounter = 0;
    chatPanel.classList.remove('drop-active');
    const files = e.dataTransfer.files;
    if (files.length) uploadFiles(files);
  });

  // Paste images from clipboard
  document.getElementById('msg-input').addEventListener('paste', (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files = [];
    for (const item of items) {
      if (item.kind === 'file') {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }
    if (files.length) {
      e.preventDefault();
      uploadFiles(files);
    }
  });
}

async function uploadFiles(fileList) {
  const progress = document.getElementById('upload-progress');

  for (const file of fileList) {
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
}

// ── Voice message recording ──

let mediaRecorder = null;
let recordingChunks = [];
let recordingStartTime = 0;
let recordingTimerInterval = null;

export function toggleRecording() {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    stopRecording();
  } else {
    startRecording();
  }
}

async function startRecording() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    // Prefer webm/opus, fall back to whatever the browser supports
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';
    mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    recordingChunks = [];

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) recordingChunks.push(e.data);
    };

    mediaRecorder.onstop = () => {
      stream.getTracks().forEach(t => t.stop());
      clearInterval(recordingTimerInterval);
      recordingTimerInterval = null;

      if (recordingChunks.length === 0) {
        hideRecordingUI();
        return;
      }

      const blob = new Blob(recordingChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
      const ext = (mediaRecorder.mimeType || '').includes('webm') ? 'webm'
                : (mediaRecorder.mimeType || '').includes('ogg') ? 'ogg'
                : (mediaRecorder.mimeType || '').includes('mp4') ? 'm4a' : 'webm';
      const filename = `voice-${new Date().toISOString().replace(/[:.]/g, '-')}.${ext}`;
      const file = new File([blob], filename, { type: blob.type });
      uploadFiles([file]);
      hideRecordingUI();
    };

    mediaRecorder.start();
    recordingStartTime = Date.now();
    showRecordingUI();
  } catch (err) {
    const progress = document.getElementById('upload-progress');
    if (err.name === 'NotAllowedError') {
      progress.textContent = 'Microphone access denied.';
    } else {
      progress.textContent = `Recording failed: ${err.message}`;
    }
  }
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop();
  }
}

export function cancelRecording() {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    recordingChunks = []; // clear so onstop won't upload
    mediaRecorder.stop();
  }
}

function showRecordingUI() {
  const btn = document.getElementById('record-btn');
  btn.classList.add('recording');
  const indicator = document.getElementById('recording-indicator');
  indicator.style.display = 'flex';
  const timer = document.getElementById('recording-timer');
  recordingTimerInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - recordingStartTime) / 1000);
    const mins = Math.floor(elapsed / 60);
    const secs = elapsed % 60;
    timer.textContent = `${mins}:${secs.toString().padStart(2, '0')}`;
  }, 250);
}

function hideRecordingUI() {
  const btn = document.getElementById('record-btn');
  btn.classList.remove('recording');
  const indicator = document.getElementById('recording-indicator');
  indicator.style.display = 'none';
  document.getElementById('recording-timer').textContent = '0:00';
  mediaRecorder = null;
  recordingChunks = [];
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

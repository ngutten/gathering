// topics.js — Topic CRUD, thread view, replies

import state from './state.js';
import { send, apiFetch } from './transport.js';
import { tryEncrypt, tryDecrypt } from './crypto.js';
import { escapeHtml, renderRichContent, formatFileSize, formatTimeAgo, renderTtlBadge, renderEncryptedBadge, renderAttachmentsHtml, decryptAndRenderAttachments, isImageMime, isAudioMime, isVideoMime } from './render.js';

export function switchView(view) {
  const prevView = state.currentView;
  const prevTopicId = state.currentTopicId;
  state.currentView = view;
  document.getElementById('chat-view').style.display = (view === 'chat') ? 'flex' : 'none';
  document.getElementById('topics-view').style.display = (view === 'topics') ? 'flex' : 'none';
  document.getElementById('thread-view').style.display = (view === 'thread') ? 'flex' : 'none';
  document.getElementById('view-chat-btn').classList.toggle('active', view === 'chat');
  document.getElementById('view-topics-btn').classList.toggle('active', view !== 'chat');
  if (view === 'topics') {
    send('ListTopics', { channel: state.currentChannel, limit: 50 });
  }
  // Push history for view transitions (unless triggered by back button)
  if (!state._skipHistoryPush && prevView !== view) {
    state.channelHistory.push({ type: 'view', channel: state.currentChannel, view: prevView, topicId: prevTopicId });
    try { history.pushState({ channel: state.currentChannel, view, topicId: state.currentTopicId }, '', ''); } catch(e) {}
  }
  state._skipHistoryPush = false;
}

export function renderTopicList(topics) {
  const el = document.getElementById('topic-list');
  if (topics.length === 0) {
    el.innerHTML = '<div class="topic-empty">No topics yet. Create one below.</div>';
    return;
  }
  el.innerHTML = topics.map(t => {
    const time = new Date(t.created_at).toLocaleDateString();
    const lastAct = formatTimeAgo(t.last_activity);
    let displayTitle = t.title;
    let encBadge = '';
    if (t.encrypted) {
      displayTitle = tryDecrypt(t.title, t.channel || state.currentChannel);
      encBadge = renderEncryptedBadge(true);
    }
    return `<div class="topic-item${t.pinned ? ' pinned' : ''}"${t.expires_at ? ` data-expires-at="${escapeHtml(t.expires_at)}"` : ''} onclick="openTopic('${escapeHtml(t.id)}')">
      <div class="topic-title">${t.pinned ? '<span class="topic-pin-icon">&#x1F4CC;</span>' : ''}${escapeHtml(displayTitle)}${encBadge}</div>
      <div class="topic-meta">by ${escapeHtml(t.author)} &middot; ${time}${t.expires_at ? ' ' + renderTtlBadge(t.expires_at) : ''}</div>
      <div class="topic-stats">${t.reply_count} ${t.reply_count === 1 ? 'reply' : 'replies'} &middot; last activity ${lastAct}</div>
    </div>`;
  }).join('');
}

export function openTopic(topicId) {
  state.currentTopicId = topicId;
  send('GetTopic', { topic_id: topicId });
  switchView('thread');
}

export function backToTopics() {
  state.currentTopicId = null;
  switchView('topics');
}

export function createTopic() {
  const titleEl = document.getElementById('new-topic-title');
  const bodyEl = document.getElementById('new-topic-body');
  let title = titleEl.value.trim();
  let body = bodyEl.value.trim();
  if (!title) return;
  const ttlVal = document.getElementById('topic-ttl-select').value;
  const encTitle = tryEncrypt(title, state.currentChannel);
  const encBody = body ? tryEncrypt(body, state.currentChannel) : { content: '', encrypted: false };
  const msg = { channel: state.currentChannel, title: encTitle.content, body: encBody.content, encrypted: encTitle.encrypted };
  if (ttlVal) msg.ttl_secs = parseInt(ttlVal);
  if (state.topicPendingAttachments.length > 0) msg.attachments = state.topicPendingAttachments.map(f => f.id);
  send('CreateTopic', msg);
  titleEl.value = '';
  bodyEl.value = '';
  state.topicPendingAttachments = [];
  renderTopicPendingFiles();
}

export function sendReply() {
  const input = document.getElementById('reply-input');
  let content = input.value.trim();
  if (!content && state.replyPendingAttachments.length === 0) return;
  if (!state.currentTopicId) return;
  const ttlVal = document.getElementById('reply-ttl-select').value;
  const enc = tryEncrypt(content || '', state.currentChannel);
  const msg = { topic_id: state.currentTopicId, content: enc.content, encrypted: enc.encrypted };
  if (ttlVal) msg.ttl_secs = parseInt(ttlVal);
  if (state.replyPendingAttachments.length > 0) msg.attachments = state.replyPendingAttachments.map(f => f.id);
  send('TopicReply', msg);
  input.value = '';
  input.style.height = 'auto';
  state.replyPendingAttachments = [];
  renderReplyPendingFiles();
}

export function handleReplyKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendReply();
    return;
  }
  e.target.style.height = 'auto';
  e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px';
}

export function renderThread(topic, replies) {
  let displayTitle = topic.title;
  let displayBody = topic.body;
  let encBadge = '';
  if (topic.encrypted) {
    const ch = topic.channel || state.currentChannel;
    displayTitle = tryDecrypt(topic.title, ch);
    displayBody = topic.body ? tryDecrypt(topic.body, ch) : '';
    encBadge = ' ' + renderEncryptedBadge(true);
  }
  document.getElementById('thread-title').innerHTML = escapeHtml(displayTitle) + encBadge;
  state.currentTopicPinned = topic.pinned;
  state.currentTopicAuthor = topic.author;
  document.getElementById('thread-pin-btn').textContent = topic.pinned ? 'Unpin' : 'Pin';
  const canEditTopic = (topic.author === state.currentUser) || state.isAdmin;
  document.getElementById('thread-edit-btn').style.display = (topic.author === state.currentUser) ? '' : 'none';
  document.getElementById('thread-delete-btn').style.display = canEditTopic ? '' : 'none';

  const time = new Date(topic.created_at).toLocaleString();
  let ttlHtml = renderTtlBadge(topic.expires_at);
  let editedHtml = topic.edited_at ? ' <span class="edited">(edited)</span>' : '';
  document.getElementById('thread-meta').textContent = `by ${topic.author} \u00B7 ${time}`;
  const bodyEl = document.getElementById('thread-body');
  bodyEl.setAttribute('data-topic-id', topic.id);
  bodyEl.setAttribute('data-topic-body', displayBody);
  bodyEl.setAttribute('data-topic-title', displayTitle);
  bodyEl.setAttribute('data-topic-encrypted', topic.encrypted ? '1' : '0');
  if (topic.expires_at) {
    bodyEl.setAttribute('data-expires-at', topic.expires_at);
  } else {
    bodyEl.removeAttribute('data-expires-at');
  }
  bodyEl.innerHTML = `<div class="meta"><span class="author">${escapeHtml(topic.author)}</span> <span class="time">${time}</span>${ttlHtml}${encBadge}${editedHtml}</div><div class="body">${renderRichContent(displayBody)}</div>${renderAttachmentsHtml(topic.attachments)}`;
  decryptAndRenderAttachments(topic.attachments);
  const repliesEl = document.getElementById('thread-replies');
  repliesEl.innerHTML = '';
  replies.forEach(r => appendTopicReply(r));
}

export function appendTopicReply(reply) {
  const el = document.getElementById('thread-replies');
  const div = document.createElement('div');
  div.className = 'msg';
  div.setAttribute('data-reply-id', reply.id);
  div.setAttribute('data-author', reply.author);
  div.setAttribute('data-encrypted', reply.encrypted ? '1' : '0');
  if (reply.expires_at) div.setAttribute('data-expires-at', reply.expires_at);

  let displayContent = reply.content;
  let encBadge = '';
  if (reply.encrypted) {
    displayContent = tryDecrypt(reply.content, state.currentChannel);
    encBadge = renderEncryptedBadge(true);
  }
  div.setAttribute('data-content', displayContent);
  div.setAttribute('data-raw-content', reply.content);

  const time = new Date(reply.created_at).toLocaleString();
  let ttlHtml = renderTtlBadge(reply.expires_at);
  let editedHtml = reply.edited_at ? '<span class="edited">(edited)</span>' : '';

  let actionsHtml = '';
  const isOwn = reply.author === state.currentUser;
  if (isOwn || state.isAdmin) {
    actionsHtml = '<div class="msg-actions">';
    if (isOwn) actionsHtml += `<button onclick="startEditReply('${reply.id}')">edit</button>`;
    actionsHtml += `<button class="del-btn" onclick="deleteReply('${reply.id}')">del</button>`;
    actionsHtml += '</div>';
  }

  div.innerHTML = `${actionsHtml}<div class="meta"><span class="author">${escapeHtml(reply.author)}</span> <span class="time">${time}</span>${ttlHtml}${encBadge}${editedHtml}</div><div class="body">${renderRichContent(displayContent)}</div>${renderAttachmentsHtml(reply.attachments)}`;
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
  decryptAndRenderAttachments(reply.attachments);
}

export function startEditTopic() {
  const bodyEl = document.getElementById('thread-body');
  const currentBody = bodyEl.getAttribute('data-topic-body') || '';
  const currentTitle = bodyEl.getAttribute('data-topic-title') || '';
  const titleEl = document.getElementById('thread-title');

  titleEl.innerHTML = `<input type="text" id="edit-topic-title" value="${escapeHtml(currentTitle)}" style="width:100%;padding:0.3rem;background:var(--bg);border:1px solid var(--accent);border-radius:4px;color:var(--text);font-family:inherit;font-size:1rem;font-weight:600;">`;

  const metaHtml = bodyEl.querySelector('.meta').outerHTML;
  bodyEl.innerHTML = `${metaHtml}<textarea id="edit-topic-body" style="width:100%;min-height:80px;padding:0.4rem;background:var(--bg);border:1px solid var(--accent);border-radius:4px;color:var(--text);font-family:inherit;font-size:0.85rem;resize:vertical;">${escapeHtml(currentBody)}</textarea>
  <div style="margin-top:0.4rem;display:flex;gap:0.3rem;">
    <button class="admin-btn-sm" onclick="saveEditTopic()">Save</button>
    <button class="admin-btn-sm danger" onclick="cancelEditTopic()">Cancel</button>
  </div>`;
}

export function saveEditTopic() {
  let title = document.getElementById('edit-topic-title').value.trim();
  let body = document.getElementById('edit-topic-body').value;
  const bodyEl = document.getElementById('thread-body');
  const wasEncrypted = bodyEl && bodyEl.getAttribute('data-topic-encrypted') === '1';
  let isEncrypted = false;
  if (wasEncrypted) {
    const encTitle = title ? tryEncrypt(title, state.currentChannel) : { content: '', encrypted: false };
    const encBody = body ? tryEncrypt(body, state.currentChannel) : { content: '', encrypted: false };
    title = encTitle.content || title;
    body = encBody.content || body;
    isEncrypted = encTitle.encrypted;
  }
  const msg = { topic_id: state.currentTopicId, encrypted: isEncrypted };
  if (title) msg.title = title;
  msg.body = body;
  send('EditTopic', msg);
}

export function cancelEditTopic() {
  send('GetTopic', { topic_id: state.currentTopicId });
}

export function deleteCurrentTopic() {
  if (!state.currentTopicId) return;
  send('DeleteTopic', { topic_id: state.currentTopicId });
}

export function startEditReply(replyId) {
  const replyEl = document.querySelector(`.msg[data-reply-id="${replyId}"]`);
  if (!replyEl) return;
  const content = replyEl.getAttribute('data-content');
  const bodyEl = replyEl.querySelector('.body');
  bodyEl.innerHTML = `<textarea id="edit-reply-textarea" style="width:100%;min-height:40px;padding:0.3rem;background:var(--bg);border:1px solid var(--accent);border-radius:4px;color:var(--text);font-family:inherit;font-size:0.85rem;resize:vertical;">${escapeHtml(content)}</textarea>
  <div style="margin-top:0.3rem;display:flex;gap:0.3rem;">
    <button class="admin-btn-sm" onclick="saveEditReply('${replyId}')">Save</button>
    <button class="admin-btn-sm danger" onclick="cancelEditReply('${replyId}')">Cancel</button>
  </div>`;
}

export function saveEditReply(replyId) {
  const textarea = document.getElementById('edit-reply-textarea');
  if (!textarea) return;
  let content = textarea.value;
  const replyEl = document.querySelector(`.msg[data-reply-id="${replyId}"]`);
  const wasEncrypted = replyEl && replyEl.getAttribute('data-encrypted') === '1';
  let isEncrypted = false;
  if (wasEncrypted) {
    const enc = tryEncrypt(content, state.currentChannel);
    content = enc.content;
    isEncrypted = enc.encrypted;
  }
  send('EditTopicReply', { reply_id: replyId, content, encrypted: isEncrypted });
}

export function cancelEditReply(replyId) {
  send('GetTopic', { topic_id: state.currentTopicId });
}

export function deleteReply(replyId) {
  send('DeleteTopicReply', { reply_id: replyId });
}

export function togglePinTopic() {
  if (!state.currentTopicId) return;
  send('PinTopic', { topic_id: state.currentTopicId, pinned: !state.currentTopicPinned });
}

// File upload helpers for topics/replies
export async function handleTopicFileSelect(event) {
  await uploadFilesTo(event, state.topicPendingAttachments, 'topic-pending-files', 'topic-upload-progress');
}

export async function handleReplyFileSelect(event) {
  await uploadFilesTo(event, state.replyPendingAttachments, 'reply-pending-files', 'reply-upload-progress');
}

async function uploadFilesTo(event, pendingList, pendingElId, progressElId) {
  const files = event.target.files;
  if (!files.length) return;
  const progress = document.getElementById(progressElId);
  for (const file of files) {
    if (file.size > 50 * 1024 * 1024) {
      progress.textContent = `${file.name}: too large (max 50MB)`;
      continue;
    }
    progress.textContent = `Uploading ${file.name}...`;
    const formData = new FormData();
    formData.append('file', file);
    formData.append('channel', state.currentChannel);
    try {
      const res = await apiFetch('/api/upload', {
        method: 'POST',
        body: formData,
      });
      const data = await res.json();
      if (data.ok && data.file) {
        pendingList.push(data.file);
        renderPendingFilesFor(pendingList, pendingElId);
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

export function renderTopicPendingFiles() { renderPendingFilesFor(state.topicPendingAttachments, 'topic-pending-files'); }
export function renderReplyPendingFiles() { renderPendingFilesFor(state.replyPendingAttachments, 'reply-pending-files'); }

function renderPendingFilesFor(list, elId) {
  const el = document.getElementById(elId);
  el.innerHTML = list.map((f, i) =>
    `<div class="pending-file">${escapeHtml(f.filename)} <span class="file-size">(${formatFileSize(f.size)})</span><span class="remove-file" onclick="removePendingFileFrom(${i},'${elId}')">&times;</span></div>`
  ).join('');
}

export function removePendingFileFrom(index, elId) {
  if (elId === 'topic-pending-files') { state.topicPendingAttachments.splice(index, 1); renderTopicPendingFiles(); }
  else if (elId === 'reply-pending-files') { state.replyPendingAttachments.splice(index, 1); renderReplyPendingFiles(); }
}

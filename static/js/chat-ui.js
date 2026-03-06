// chat-ui.js — Message rendering, channel list, online users, DMs, typing

import state, { isDMChannel, emit } from './state.js';
import { send } from './transport.js';
import { escapeHtml, renderRichContent, formatFileSize, isImageMime, isAudioMime, isVideoMime, renderAttachmentsHtml, decryptAndRenderAttachments, renderTtlBadge, renderEncryptedBadge } from './render.js';
import { tryDecrypt } from './crypto.js';
import { apiUrl, fileUrl } from './config.js';

const TYPING_INDICATOR_TIMEOUT_MS = 3000;
const CHANNEL_SETTINGS_REFRESH_DELAY_MS = 300;
const MSG_GROUP_WINDOW_MS = 5 * 60 * 1000; // 5 minutes


export function appendMessage(msg) {
  if (msg.channel && msg.channel !== state.currentChannel) return;

  const el = document.getElementById('messages');
  const div = document.createElement('div');
  div.className = 'msg';
  div.setAttribute('data-msg-id', msg.id);
  div.setAttribute('data-author', msg.author);
  div.setAttribute('data-timestamp', msg.timestamp);

  const time = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const ttlHtml = renderTtlBadge(msg.expires_at);

  let editedHtml = '';
  if (msg.edited_at) {
    editedHtml = '<span class="edited">(edited)</span>';
  }

  let displayContent = msg.content;
  let encBadge = '';
  if (msg.encrypted) {
    displayContent = tryDecrypt(msg.content, msg.channel || state.currentChannel);
    encBadge = renderEncryptedBadge(true);
  }
  div.setAttribute('data-content', msg.encrypted ? displayContent : msg.content);
  div.setAttribute('data-encrypted', msg.encrypted ? '1' : '0');
  div.setAttribute('data-raw-content', msg.content);

  const content = renderRichContent(displayContent);

  // Build attachments HTML (handles encrypted placeholders via render.js)
  const attachHtml = renderAttachmentsHtml(msg.attachments);

  // Action buttons
  let actionsHtml = '';
  const isOwn = msg.author === state.currentUser;
  if (isOwn || state.isAdmin) {
    actionsHtml = '<div class="msg-actions">';
    actionsHtml += `<button onclick="startReply('${msg.id}')">reply</button>`;
    if (isOwn) actionsHtml += `<button onclick="startEditMessage('${msg.id}')">edit</button>`;
    actionsHtml += `<button class="del-btn" onclick="deleteMessage('${msg.id}')">del</button>`;
    actionsHtml += '</div>';
  } else {
    actionsHtml = '<div class="msg-actions"><button onclick="startReply(\''+msg.id+'\')">reply</button></div>';
  }

  // Reply reference bar
  let replyHtml = '';
  if (msg.reply_to) {
    replyHtml = `<div class="reply-ref" data-reply-id="${escapeHtml(msg.reply_to.message_id)}" onclick="scrollToMessage('${escapeHtml(msg.reply_to.message_id)}')">
      <span class="reply-author">@${escapeHtml(msg.reply_to.author)}</span>: ${escapeHtml(msg.reply_to.snippet)}
    </div>`;
  }

  // Message consolidation: check if same author and within 5 minutes
  const isContinuation = checkContinuation(el, msg);
  if (isContinuation) {
    div.classList.add('msg-continuation');
  }

  div.innerHTML = `${actionsHtml}${replyHtml}
    <div class="meta">
      <span class="author">${escapeHtml(msg.author)}</span>
      <span class="time">${time}</span>${ttlHtml}${encBadge}${editedHtml}
    </div>
    <div class="body">${content}</div>${attachHtml}`;
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;

  // Decrypt and render any encrypted attachments now that they're in the DOM
  decryptAndRenderAttachments(msg.attachments);
}

function checkContinuation(container, msg) {
  // Find the last non-system .msg element
  const allMsgs = container.querySelectorAll('.msg:not(.system)');
  if (allMsgs.length === 0) return false;
  const lastMsg = allMsgs[allMsgs.length - 1];
  const lastAuthor = lastMsg.getAttribute('data-author');
  const lastTs = lastMsg.getAttribute('data-timestamp');
  if (!lastAuthor || !lastTs) return false;
  if (lastAuthor !== msg.author) return false;
  if (msg.reply_to) return false; // replies break grouping
  const diff = new Date(msg.timestamp) - new Date(lastTs);
  return diff >= 0 && diff < MSG_GROUP_WINDOW_MS;
}

export function startReply(msgId) {
  const msgEl = document.querySelector(`.msg[data-msg-id="${msgId}"]`);
  if (!msgEl) return;
  const author = msgEl.getAttribute('data-author');
  const content = msgEl.getAttribute('data-content') || '';
  const snippet = content.substring(0, 100);
  state.replyTo = { message_id: msgId, author, snippet };
  const banner = document.getElementById('reply-banner');
  if (banner) {
    banner.querySelector('.reply-banner-text').textContent = `Replying to @${author}: ${snippet}`;
    banner.classList.add('active');
  }
  document.getElementById('msg-input').focus();
}

export function cancelReply() {
  state.replyTo = null;
  const banner = document.getElementById('reply-banner');
  if (banner) banner.classList.remove('active');
}

export function appendSystem(text) {
  const el = document.getElementById('messages');
  const div = document.createElement('div');
  div.className = 'msg system';
  div.textContent = text;
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
}

export function renderChannels() {
  state.channels.forEach(ch => { if (ch.encrypted) state.encryptedChannels.add(ch.name); });

  // Separate text and voice channels
  const textChannels = state.channels.filter(ch => !isDMChannel(ch.name) && ch.channel_type !== 'voice');
  const voiceChannels = state.channels.filter(ch => ch.channel_type === 'voice');
  state.voiceChannels = voiceChannels;

  // Render text channels
  const el = document.getElementById('channel-list');
  el.innerHTML = textChannels.map(ch => {
    const lock = ch.encrypted ? '&#x1F512; ' : ch.restricted ? '&#x1F6E1; ' : '#';
    const unread = state.unreadCounts[ch.name] || 0;
    const unreadBadge = unread > 0 ? `<span class="unread-badge">${unread > 99 ? '99+' : unread}</span>` : '';
    const boldClass = unread > 0 ? ' has-unread' : '';
    const noKeyClass = ch.encrypted && !state.e2eReady ? ' no-e2e-key' : '';
    return `<div class="channel-item${boldClass}${noKeyClass} ${ch.name === state.currentChannel ? 'active' : ''}"
         onclick="switchChannel('${escapeHtml(ch.name)}')">
      <span>${lock}${escapeHtml(ch.name)}</span>
      <span class="channel-right">${unreadBadge}<span class="count">${ch.user_count}</span></span>
    </div>`;
  }).join('');

  // Render voice channels
  renderVoiceChannelList();
}

export function renderVoiceChannelList() {
  const el = document.getElementById('voice-channel-list');
  if (!el) return;
  const voiceChannels = state.voiceChannels || [];
  el.innerHTML = voiceChannels.map(ch => {
    const isActive = ch.name === state.activeVoiceChannel;
    const isViewing = ch.name === state.currentChannel;
    const occupants = state.voiceChannelOccupancy[ch.name] || [];
    const unread = state.unreadCounts[ch.name] || 0;
    const unreadBadge = unread > 0 ? `<span class="unread-badge">${unread > 99 ? '99+' : unread}</span>` : '';
    const boldClass = unread > 0 ? ' has-unread' : '';

    let html = `<div class="voice-channel-item${boldClass}${isViewing ? ' viewing' : ''}">
      <div class="voice-channel-header" onclick="switchChannel('${escapeHtml(ch.name)}')">
        <span class="voice-channel-name">&#x1F50A; ${escapeHtml(ch.name)}</span>
        <span class="channel-right">${unreadBadge}</span>
      </div>`;

    // Show occupants
    if (occupants.length > 0) {
      html += '<div class="voice-channel-occupants">';
      occupants.forEach(u => {
        html += `<div class="voice-channel-user"><span class="voice-dot"></span>${escapeHtml(u)}</div>`;
      });
      html += '</div>';
    }

    // Join/leave button
    if (isActive) {
      html += `<button class="voice-ch-btn voice-ch-leave" onclick="leaveVoice()">Leave</button>`;
    } else {
      html += `<button class="voice-ch-btn voice-ch-join" onclick="joinVoiceChannel('${escapeHtml(ch.name)}')">Join</button>`;
    }

    html += '</div>';
    return html;
  }).join('');

  // Create voice channel input
  const createEl = document.getElementById('create-voice-channel');
  if (createEl && voiceChannels.length === 0 && !createEl.dataset.initialized) {
    // Always show the input
  }
}

export function renderOnlineUsers(users) {
  const el = document.getElementById('online-users');
  el.innerHTML = users.map(u => {
    const dmBtn = u !== state.currentUser ?
      `<button class="dm-btn" onclick="startDM('${escapeHtml(u)}')" title="Message ${escapeHtml(u)}">&#x2709;</button>` : '';
    return `<div class="user-item"><span class="user-item-name">${escapeHtml(u)}</span>${dmBtn}</div>`;
  }).join('');
}

export function renderDMList() {
  const el = document.getElementById('dm-list');
  const entries = Object.entries(state.dmChannels);
  if (entries.length === 0) {
    el.innerHTML = '';
    return;
  }
  el.innerHTML = entries.map(([ch, other]) => {
    const unread = state.unreadCounts[ch] || 0;
    const unreadBadge = unread > 0 ? `<span class="unread-badge">${unread > 99 ? '99+' : unread}</span>` : '';
    const boldClass = unread > 0 ? ' has-unread' : '';
    const noKeyClass = !state.e2eReady ? ' no-e2e-key' : '';
    return `<div class="dm-item${boldClass}${noKeyClass} ${ch === state.currentChannel ? 'active' : ''}" onclick="switchChannel('${escapeHtml(ch)}')">
      <span class="dm-name">&#x1F512; ${escapeHtml(other)}</span>
      ${unreadBadge}
    </div>`;
  }).join('');
}

export function startDM(targetUser) {
  send('StartDM', { target_user: targetUser });
}

export function showTyping(username) {
  const el = document.getElementById('typing-indicator');
  el.textContent = `${username} is typing...`;
  clearTimeout(state.typingTimers[username]);
  state.typingTimers[username] = setTimeout(() => {
    el.textContent = '';
  }, TYPING_INDICATOR_TIMEOUT_MS);
}

// ── Video Tile Functions ──

export function addVideoTile(username, type, stream) {
  const grid = document.getElementById('video-grid');
  if (!grid) return;
  const tileId = `video-tile-${username}-${type}`;
  // Remove existing tile if any
  const existing = document.getElementById(tileId);
  if (existing) existing.remove();

  const div = document.createElement('div');
  div.id = tileId;
  div.className = type === 'screen' ? 'screen-share-tile' : 'video-tile';

  const video = document.createElement('video');
  video.autoplay = true;
  video.playsInline = true;
  // Mute local self-view to prevent feedback
  if (username === state.currentUser) {
    video.muted = true;
    if (type === 'camera') video.classList.add('local-camera');
  }
  video.srcObject = stream;

  const label = document.createElement('div');
  label.className = 'video-label';
  label.textContent = type === 'screen' ? `${username} (screen)` : username;

  const pinBtn = document.createElement('button');
  pinBtn.className = 'video-pin-btn';
  pinBtn.title = 'Pin tile';
  pinBtn.textContent = '\u{1F4CC}';
  pinBtn.onclick = (e) => {
    e.stopPropagation();
    togglePinTile(tileId);
  };

  div.appendChild(video);
  div.appendChild(label);
  div.appendChild(pinBtn);

  // Screen tiles prepended (shown first), unless there's a pinned tile
  if (type === 'screen') {
    grid.prepend(div);
  } else {
    grid.appendChild(div);
  }

  // Auto-pin screen share tiles when they're the first tile
  if (type === 'screen' && !grid.querySelector('.pinned')) {
    togglePinTile(tileId);
  }
}

function togglePinTile(tileId) {
  const grid = document.getElementById('video-grid');
  if (!grid) return;
  const tile = document.getElementById(tileId);
  if (!tile) return;

  const wasPinned = tile.classList.contains('pinned');

  // Remove pinned from all tiles
  grid.querySelectorAll('.pinned').forEach(el => el.classList.remove('pinned'));

  // Toggle the grid layout
  if (wasPinned) {
    grid.classList.remove('has-pinned');
  } else {
    tile.classList.add('pinned');
    grid.classList.add('has-pinned');
    // Move pinned tile to be the first child
    grid.prepend(tile);
  }
}

export function removeVideoTile(username, type) {
  const el = document.getElementById(`video-tile-${username}-${type}`);
  if (el) {
    const wasPinned = el.classList.contains('pinned');
    el.remove();
    if (wasPinned) {
      const grid = document.getElementById('video-grid');
      if (grid) grid.classList.remove('has-pinned');
    }
  }
}

export function removeAllTilesForUser(username) {
  removeVideoTile(username, 'camera');
  removeVideoTile(username, 'screen');
}

export function removeAllVideoTiles() {
  const grid = document.getElementById('video-grid');
  if (grid) {
    grid.innerHTML = '';
    grid.classList.remove('has-pinned');
  }
}

export function renderChannelMemberPanel(msg) {
  const overlay = document.getElementById('channel-settings-overlay');
  if (!overlay) return;
  const content = document.getElementById('channel-settings-content');
  if (!content) return;

  const isAdmin = state.isAdmin;
  const isCreator = state.channelCreators && state.channelCreators[msg.channel] === state.currentUser;
  const canManage = isAdmin || isCreator;

  let html = `<div style="margin-bottom:0.5rem;">
    <strong>${escapeHtml(msg.channel)}</strong>
    <span style="color:var(--text2);font-size:0.75rem;margin-left:0.5rem;">${msg.restricted ? 'Restricted' : 'Open'}</span>
  </div>`;

  if (canManage) {
    html += `<div style="margin-bottom:0.5rem;">
      <label style="font-size:0.75rem;cursor:pointer;">
        <input type="checkbox" ${msg.restricted ? 'checked' : ''} onchange="toggleChannelRestricted('${escapeHtml(msg.channel)}', this.checked)">
        Restrict to members only
      </label>
    </div>`;
  }

  if (msg.restricted) {
    html += '<div style="font-size:0.75rem;color:var(--text2);margin-bottom:0.3rem;">Members:</div>';
    for (const member of msg.members) {
      html += `<div class="user-item" style="display:flex;justify-content:space-between;align-items:center;">
        <span>${escapeHtml(member)}</span>
        ${canManage && member !== state.currentUser ? `<button class="admin-btn-sm danger" onclick="removeChannelMember('${escapeHtml(msg.channel)}','${escapeHtml(member)}')">Remove</button>` : ''}
      </div>`;
    }
    if (canManage) {
      html += `<div style="display:flex;gap:0.3rem;margin-top:0.5rem;">
        <input type="text" id="add-member-input" placeholder="username" style="flex:1;">
        <button class="admin-btn-sm" onclick="addChannelMember('${escapeHtml(msg.channel)}')">Add</button>
      </div>`;
    }
  }

  // Re-key button for encrypted channels
  if (state.encryptedChannels.has(msg.channel) && state.channelKeys[msg.channel]) {
    html += `<div style="margin-top:0.7rem;padding-top:0.5rem;border-top:1px solid var(--border);">
      <div style="font-size:0.7rem;color:var(--red);margin-bottom:0.3rem;">Danger Zone</div>
      <button class="admin-btn-sm danger" onclick="rekeyChannel('${escapeHtml(msg.channel)}')" title="All existing messages will become permanently unreadable">Re-key Channel</button>
    </div>`;
  }

  content.innerHTML = html;
  overlay.classList.add('active');
}

export function openChannelSettings() {
  if (!state.currentChannel || state.currentChannel === 'general') return;
  send('GetChannelMembers', { channel: state.currentChannel });
}

export function closeChannelSettings() {
  const overlay = document.getElementById('channel-settings-overlay');
  if (overlay) overlay.classList.remove('active');
}

export function toggleChannelRestricted(channel, restricted) {
  send('SetChannelRestricted', { channel, restricted });
  // Refresh the member list after a short delay
  setTimeout(() => send('GetChannelMembers', { channel }), CHANNEL_SETTINGS_REFRESH_DELAY_MS);
}

export function addChannelMember(channel) {
  const input = document.getElementById('add-member-input');
  if (!input) return;
  const username = input.value.trim();
  if (!username) return;
  send('AddChannelMember', { channel, username });
  input.value = '';
  setTimeout(() => send('GetChannelMembers', { channel }), CHANNEL_SETTINGS_REFRESH_DELAY_MS);
}

export function removeChannelMember(channel, username) {
  send('RemoveChannelMember', { channel, username });
  setTimeout(() => send('GetChannelMembers', { channel }), CHANNEL_SETTINGS_REFRESH_DELAY_MS);
}

export function switchChannel(name) {
  state.currentChannel = name;
  state.currentTopicId = null;
  state.topicsList = [];
  // Clear unread for this channel
  state.unreadCounts[name] = 0;
  state.lastReadTimestamps[name] = new Date().toISOString();
  try { localStorage.setItem('gathering_last_read_' + name, state.lastReadTimestamps[name]); } catch(e) {}
  const isVoice = state.voiceChannels && state.voiceChannels.some(ch => ch.name === name);
  if (isDMChannel(name)) {
    const other = state.dmChannels[name] || name;
    document.getElementById('chat-channel-name').textContent = `DM: ${other}`;
    document.querySelector('.view-toggle').style.display = 'none';
  } else if (isVoice) {
    document.getElementById('chat-channel-name').textContent = `\u{1F50A} ${name}`;
    document.querySelector('.view-toggle').style.display = 'none';
  } else {
    document.getElementById('chat-channel-name').textContent = `#${name}`;
    document.querySelector('.view-toggle').style.display = '';
  }
  document.getElementById('messages').innerHTML = '';
  renderChannels();
  renderDMList();
  updateRequestKeyButton();
  // Import switchView dynamically to avoid circular deps
  import('./topics.js').then(m => m.switchView('chat'));
  // Always send Join — server is idempotent (skips broadcast if already joined)
  // and responds with history + channel key delivery
  send('Join', { channel: name });
  // Emit after Join so the server has registered us in the channel
  // before widget presence requests are sent
  emit('channel-switched', name);
  if (state.encryptedChannels.has(name) && !state.e2eReady) {
    appendSystem('This is an encrypted channel. Generate or import an E2E key (bottom of sidebar) to participate.');
  } else if (state.encryptedChannels.has(name) && !state.channelKeys[name] && state.e2eReady) {
    send('RequestChannelKey', { channel: name });
  }
}

/** Show/hide the "Request Key" button based on current channel state */
export function updateRequestKeyButton() {
  const btn = document.getElementById('request-key-btn');
  if (!btn) return;
  const ch = state.currentChannel;
  const needsKey = state.encryptedChannels.has(ch) && !state.channelKeys[ch] && state.e2eReady;
  btn.style.display = needsKey ? '' : 'none';
}

// Client-side rate limit: track last request time per channel
const _keyRequestTimes = {};
const KEY_REQUEST_COOLDOWN_MS = 30000; // 30 seconds

export function requestChannelKey() {
  const ch = state.currentChannel;
  if (!ch || !state.encryptedChannels.has(ch) || state.channelKeys[ch]) return;

  const now = Date.now();
  const last = _keyRequestTimes[ch] || 0;
  if (now - last < KEY_REQUEST_COOLDOWN_MS) {
    const wait = Math.ceil((KEY_REQUEST_COOLDOWN_MS - (now - last)) / 1000);
    appendSystem(`Key request cooldown — try again in ${wait}s`);
    return;
  }
  _keyRequestTimes[ch] = now;
  send('RequestChannelKey', { channel: ch });
  appendSystem('Requested encryption key from online channel members...');
}

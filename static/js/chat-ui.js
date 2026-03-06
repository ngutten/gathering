// chat-ui.js — Message rendering, channel list, online users, DMs, typing

import state, { isDMChannel, emit } from './state.js';
import { send } from './transport.js';
import { escapeHtml, renderRichContent, formatFileSize, isImageMime, isAudioMime, isVideoMime, renderAttachmentsHtml, decryptAndRenderAttachments, renderTtlBadge, renderEncryptedBadge } from './render.js';
import { tryDecrypt } from './crypto.js';
import { apiUrl, fileUrl } from './config.js';
import { openReactionPicker, closeReactionPicker } from './emoji.js';

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
  const canPin = state.isAdmin || (state.channelCreators && state.channelCreators[msg.channel || state.currentChannel] === state.currentUser);
  const isEncrypted = state.encryptedChannels.has(msg.channel || state.currentChannel);
  actionsHtml = '<div class="msg-actions">';
  if (!isEncrypted) actionsHtml += `<button class="react-btn" data-msg-id="${msg.id}">+&#x1F600;</button>`;
  actionsHtml += `<button onclick="startReply('${msg.id}')">reply</button>`;
  if (canPin) actionsHtml += `<button onclick="togglePinMessage('${msg.id}')">${msg.pinned ? 'unpin' : 'pin'}</button>`;
  if (isOwn) actionsHtml += `<button onclick="startEditMessage('${msg.id}')">edit</button>`;
  if (isOwn || state.isAdmin) actionsHtml += `<button class="del-btn" onclick="deleteMessage('${msg.id}')">del</button>`;
  actionsHtml += '</div>';

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

  const pinnedBadge = msg.pinned ? '<span class="pinned-badge" title="Pinned">&#x1F4CC;</span>' : '';
  const reactionsHtml = renderReactionsBar(msg.id, msg.reactions);

  div.innerHTML = `${actionsHtml}${replyHtml}
    <div class="meta">
      ${pinnedBadge}${isContinuation ? '' : avatarHtml(msg.author, 20)}<span class="author" onclick="openProfile('${escapeHtml(msg.author)}')" style="cursor:pointer;">${escapeHtml(msg.author)}</span>
      <span class="time">${time}</span>${ttlHtml}${encBadge}${editedHtml}
    </div>
    <div class="body">${content}</div>${attachHtml}${reactionsHtml}`;
  // Insert date header if this message is on a different day than the previous
  maybeInsertDateHeader(el, msg);

  el.appendChild(div);

  // Wire up the reaction picker button
  const reactBtn = div.querySelector('.react-btn');
  if (reactBtn) {
    reactBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openReactionPicker(reactBtn, (emoji) => {
        send('AddReaction', { message_id: msg.id, emoji });
      });
    });
  }

  // Wire up existing reaction buttons for toggle behavior
  div.querySelectorAll('.reactions-bar .reaction').forEach(btn => {
    btn.addEventListener('click', () => {
      const action = btn.classList.contains('mine') ? 'RemoveReaction' : 'AddReaction';
      send(action, { message_id: btn.getAttribute('data-msg-id'), emoji: btn.getAttribute('data-emoji') });
    });
  });

  el.scrollTop = el.scrollHeight;

  // Decrypt and render any encrypted attachments now that they're in the DOM
  decryptAndRenderAttachments(msg.attachments);
}

function maybeInsertDateHeader(container, msg) {
  const msgDate = new Date(msg.timestamp);
  const msgDay = new Date(msgDate.getFullYear(), msgDate.getMonth(), msgDate.getDate());

  // Find the last message (any type) to compare dates
  const allEls = container.querySelectorAll('.msg:not(.date-header)');
  if (allEls.length === 0) {
    // First message — always show date header
    insertDateHeader(container, msgDay);
    return;
  }
  const lastEl = allEls[allEls.length - 1];
  const lastTs = lastEl.getAttribute('data-timestamp');
  if (!lastTs) {
    insertDateHeader(container, msgDay);
    return;
  }
  const lastDate = new Date(lastTs);
  const lastDay = new Date(lastDate.getFullYear(), lastDate.getMonth(), lastDate.getDate());
  if (msgDay.getTime() !== lastDay.getTime()) {
    insertDateHeader(container, msgDay);
  }
}

function insertDateHeader(container, date) {
  const today = new Date();
  const todayDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const yesterday = new Date(todayDay); yesterday.setDate(yesterday.getDate() - 1);

  let label;
  if (date.getTime() === todayDay.getTime()) {
    label = 'Today';
  } else if (date.getTime() === yesterday.getTime()) {
    label = 'Yesterday';
  } else {
    label = date.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  }
  const div = document.createElement('div');
  div.className = 'msg date-header';
  div.innerHTML = `<span>${escapeHtml(label)}</span>`;
  container.appendChild(div);
}

function checkContinuation(container, msg) {
  // Find the last non-system .msg element
  const allMsgs = container.querySelectorAll('.msg:not(.system):not(.date-header)');
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
    const hasMention = state.unreadMentions[ch.name];
    const badgeClass = hasMention ? 'unread-badge unread-mention' : 'unread-badge';
    const unreadBadge = unread > 0 ? `<span class="${badgeClass}">${unread > 99 ? '99+' : unread}</span>` : '';
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
    const hasMention = state.unreadMentions[ch.name];
    const badgeClass = hasMention ? 'unread-badge unread-mention' : 'unread-badge';
    const unreadBadge = unread > 0 ? `<span class="${badgeClass}">${unread > 99 ? '99+' : unread}</span>` : '';
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
  // Request profiles for users we haven't cached yet
  const uncached = users.filter(u => !state.profileCache[u]);
  if (uncached.length > 0) {
    send('GetProfiles', { usernames: uncached });
  }
  el.innerHTML = users.map(u => {
    const dmBtn = u !== state.currentUser ?
      `<button class="dm-btn" onclick="startDM('${escapeHtml(u)}')" title="Message ${escapeHtml(u)}">&#x2709;</button>` : '';
    const profile = state.profileCache[u] || {};
    const statusHtml = profile.status ? `<span class="user-item-status" title="${escapeHtml(profile.status)}">${escapeHtml(profile.status)}</span>` : '';
    return `<div class="user-item">
      <span class="user-item-name" onclick="openProfile('${escapeHtml(u)}')" style="cursor:pointer;">
        ${avatarHtml(u, 18)}${escapeHtml(u)}
      </span>
      ${statusHtml}${dmBtn}
    </div>`;
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
    const hasMention = state.unreadMentions[ch];
    const badgeClass = hasMention ? 'unread-badge unread-mention' : 'unread-badge';
    const unreadBadge = unread > 0 ? `<span class="${badgeClass}">${unread > 99 ? '99+' : unread}</span>` : '';
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
  delete state.unreadMentions[name];
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
  // Reset pinned banner for the new channel
  const pinnedList = document.getElementById('pinned-banner-list');
  if (pinnedList) pinnedList.style.display = 'none';
  const pinnedToggle = document.getElementById('pinned-banner-toggle');
  if (pinnedToggle) pinnedToggle.classList.remove('expanded');
  renderPinnedBanner();
  send('GetPinnedMessages', { channel: name });
  renderChannels();
  renderDMList();
  updateRequestKeyButton();
  // Hide widgets on encrypted channels (data leak risk)
  const widgetBtn = document.getElementById('widget-toolbar-btn');
  if (widgetBtn) widgetBtn.style.display = state.encryptedChannels.has(name) ? 'none' : '';
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

// ── Reactions ──

function renderReactionsBar(msgId, reactions) {
  if (!reactions || Object.keys(reactions).length === 0) return '';
  let html = '<div class="reactions-bar">';
  for (const [emoji, users] of Object.entries(reactions)) {
    const isMine = users.includes(state.currentUser);
    const cls = isMine ? 'reaction mine' : 'reaction';
    const title = users.join(', ');
    html += `<button class="${cls}" title="${escapeHtml(title)}" data-msg-id="${escapeHtml(msgId)}" data-emoji="${escapeHtml(emoji)}">${escapeHtml(emoji)} ${users.length}</button>`;
  }
  html += '</div>';
  return html;
}

export function updateReactionInDOM(msg) {
  const msgEl = document.querySelector(`.msg[data-msg-id="${msg.message_id}"]`);
  if (!msgEl) return;

  // Update in-memory reactions on the element
  let bar = msgEl.querySelector('.reactions-bar');
  if (msg.added) {
    // Add reaction
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'reactions-bar';
      msgEl.appendChild(bar);
    }
    let btn = bar.querySelector(`button[data-emoji="${CSS.escape(msg.emoji)}"]`);
    if (btn) {
      const title = btn.getAttribute('title');
      const users = title ? title.split(', ') : [];
      if (!users.includes(msg.username)) users.push(msg.username);
      btn.setAttribute('title', users.join(', '));
      btn.textContent = `${msg.emoji} ${users.length}`;
      if (msg.username === state.currentUser) btn.classList.add('mine');
    } else {
      btn = document.createElement('button');
      btn.className = msg.username === state.currentUser ? 'reaction mine' : 'reaction';
      btn.setAttribute('data-msg-id', msg.message_id);
      btn.setAttribute('data-emoji', msg.emoji);
      btn.setAttribute('title', msg.username);
      btn.textContent = `${msg.emoji} 1`;
      btn.addEventListener('click', () => {
        const action = btn.classList.contains('mine') ? 'RemoveReaction' : 'AddReaction';
        send(action, { message_id: msg.message_id, emoji: msg.emoji });
      });
      bar.appendChild(btn);
    }
  } else {
    // Remove reaction
    if (!bar) return;
    const btn = bar.querySelector(`button[data-emoji="${CSS.escape(msg.emoji)}"]`);
    if (!btn) return;
    const title = btn.getAttribute('title');
    const users = title ? title.split(', ').filter(u => u !== msg.username) : [];
    if (users.length === 0) {
      btn.remove();
      if (bar.children.length === 0) bar.remove();
    } else {
      btn.setAttribute('title', users.join(', '));
      btn.textContent = `${msg.emoji} ${users.length}`;
      if (msg.username === state.currentUser) btn.classList.remove('mine');
    }
  }
}

export function togglePinMessage(msgId) {
  const msgEl = document.querySelector(`.msg[data-msg-id="${msgId}"]`);
  if (!msgEl) return;
  const isPinned = !!msgEl.querySelector('.pinned-badge');
  send('PinMessage', { message_id: msgId, pinned: !isPinned });
}

export function updatePinInDOM(msg) {
  const msgEl = document.querySelector(`.msg[data-msg-id="${msg.message_id}"]`);
  if (!msgEl) return;
  const meta = msgEl.querySelector('.meta');
  if (!meta) return;
  const existing = meta.querySelector('.pinned-badge');
  if (msg.pinned && !existing) {
    const badge = document.createElement('span');
    badge.className = 'pinned-badge';
    badge.title = 'Pinned';
    badge.innerHTML = '&#x1F4CC;';
    meta.insertBefore(badge, meta.firstChild);
  } else if (!msg.pinned && existing) {
    existing.remove();
  }
  // Update the pin/unpin button text
  const canPin = state.isAdmin || (state.channelCreators && state.channelCreators[msg.channel] === state.currentUser);
  if (canPin) {
    const actions = msgEl.querySelector('.msg-actions');
    if (actions) {
      const pinBtn = Array.from(actions.querySelectorAll('button')).find(b => b.textContent === 'pin' || b.textContent === 'unpin');
      if (pinBtn) pinBtn.textContent = msg.pinned ? 'unpin' : 'pin';
    }
  }
}

export function openPinnedPanel() {
  send('GetPinnedMessages', { channel: state.currentChannel });
}

export function closePinnedPanel() {
  const overlay = document.getElementById('pinned-messages-overlay');
  if (overlay) overlay.classList.remove('active');
}

export function renderPinnedPanel(msg) {
  // Cache the pinned messages
  state.pinnedMessages[msg.channel] = msg.messages;

  // Update the banner
  if (msg.channel === state.currentChannel) {
    renderPinnedBanner();
  }

  // Also update the overlay if it's open
  const overlay = document.getElementById('pinned-messages-overlay');
  if (overlay && overlay.classList.contains('active')) {
    const content = document.getElementById('pinned-messages-content');
    if (!content) return;
    if (msg.messages.length === 0) {
      content.innerHTML = '<div style="color:var(--text2);font-size:0.8rem;">No pinned messages in this channel.</div>';
    } else {
      content.innerHTML = msg.messages.map(m => {
        let displayContent = m.content;
        if (m.encrypted) displayContent = tryDecrypt(m.content, msg.channel);
        const rendered = renderRichContent(displayContent);
        const time = new Date(m.timestamp).toLocaleString();
        return `<div class="pinned-msg" onclick="scrollToMessage('${escapeHtml(m.id)}'); closePinnedPanel();">
          <div class="meta"><span class="author">${escapeHtml(m.author)}</span> <span class="time">${time}</span></div>
          <div class="body">${rendered}</div>
        </div>`;
      }).join('');
    }
  }
}

// ── Pinned banner ──

export function renderPinnedBanner() {
  const banner = document.getElementById('pinned-banner');
  if (!banner) return;

  const pins = state.pinnedMessages[state.currentChannel] || [];
  if (pins.length === 0) {
    banner.style.display = 'none';
    return;
  }

  banner.style.display = '';
  const textEl = document.getElementById('pinned-banner-text');

  if (pins.length === 1) {
    const p = pins[0];
    let content = p.content;
    if (p.encrypted) content = tryDecrypt(p.content, state.currentChannel);
    const snippet = content.length > 80 ? content.substring(0, 80) + '...' : content;
    textEl.innerHTML = `<strong>${escapeHtml(p.author)}</strong>: ${escapeHtml(snippet)}`;
  } else {
    textEl.innerHTML = `<strong>${pins.length} pinned messages</strong>`;
  }

  // Render the expanded list
  const listEl = document.getElementById('pinned-banner-list');
  listEl.innerHTML = pins.map(m => {
    let displayContent = m.content;
    if (m.encrypted) displayContent = tryDecrypt(m.content, state.currentChannel);
    const rendered = renderRichContent(displayContent);
    const time = new Date(m.timestamp).toLocaleString();
    return `<div class="pinned-banner-item" onclick="scrollToMessage('${escapeHtml(m.id)}')">
      <div class="meta"><span class="author">${escapeHtml(m.author)}</span> <span class="time">${time}</span></div>
      <div class="body">${rendered}</div>
    </div>`;
  }).join('');
}

export function togglePinnedBanner() {
  const listEl = document.getElementById('pinned-banner-list');
  const toggleEl = document.getElementById('pinned-banner-toggle');
  if (!listEl) return;
  const expanded = listEl.style.display !== 'none';
  listEl.style.display = expanded ? 'none' : '';
  if (toggleEl) toggleEl.classList.toggle('expanded', !expanded);
}

// ── Profile functions ──

export function avatarHtml(username, size) {
  const sz = size || 24;
  const profile = state.profileCache[username];
  if (profile && profile.avatar_id) {
    const url = fileUrl('/api/files/' + profile.avatar_id);
    return `<img class="user-avatar" src="${url}" alt="" style="width:${sz}px;height:${sz}px;border-radius:50%;object-fit:cover;">`;
  }
  // Generate a color from the username
  let hash = 0;
  for (let i = 0; i < username.length; i++) hash = username.charCodeAt(i) + ((hash << 5) - hash);
  const hue = ((hash % 360) + 360) % 360;
  const initial = username.charAt(0).toUpperCase();
  return `<span class="user-avatar user-avatar-default" style="width:${sz}px;height:${sz}px;line-height:${sz}px;font-size:${Math.round(sz * 0.5)}px;border-radius:50%;background:hsl(${hue},50%,35%);color:#fff;display:inline-flex;align-items:center;justify-content:center;">${escapeHtml(initial)}</span>`;
}

export function refreshAvatarsInDOM(username) {
  // Update all avatar elements for this user in the messages area
  const msgs = document.querySelectorAll(`.msg[data-author="${CSS.escape(username)}"]`);
  msgs.forEach(msgEl => {
    const avatar = msgEl.querySelector('.meta .user-avatar');
    if (avatar) {
      const parent = avatar.parentNode;
      const newAvatar = document.createRange().createContextualFragment(avatarHtml(username, 20));
      parent.replaceChild(newAvatar, avatar);
    }
  });
}

export function openProfile(username) {
  send('GetProfile', { username });
  // Show modal immediately with cached data (will update when response arrives)
  renderProfileModal(username);
  document.getElementById('profile-overlay').classList.add('active');
}

export function closeProfile() {
  document.getElementById('profile-overlay').classList.remove('active');
}

export function renderProfileModal(username) {
  const profile = state.profileCache[username] || {};
  const isOwn = username === state.currentUser;
  const el = document.getElementById('profile-content');
  const avatarBig = profile.avatar_id
    ? `<img class="profile-avatar-big" src="${fileUrl('/api/files/' + profile.avatar_id)}" alt="">`
    : avatarHtml(username, 80);
  const statusText = profile.status ? escapeHtml(profile.status) : '<span style="color:var(--text2)">No status set</span>';
  const aboutText = profile.about ? escapeHtml(profile.about).replace(/\n/g, '<br>') : '<span style="color:var(--text2)">No about info</span>';

  el.setAttribute('data-profile-user', username);
  el.innerHTML = `
    <div class="profile-card">
      <div class="profile-header">
        <div class="profile-avatar-wrap">${avatarBig}</div>
        <div class="profile-name-section">
          <div class="profile-username">${escapeHtml(username)}</div>
          <div class="profile-status">${statusText}</div>
        </div>
      </div>
      <div class="profile-about-section">
        <div class="profile-label">About</div>
        <div class="profile-about">${aboutText}</div>
      </div>
      ${isOwn ? '<div class="profile-edit-section"><button class="profile-edit-btn" onclick="openEditProfile()">Edit Profile</button></div>' : ''}
    </div>
  `;
}

export function openEditProfile() {
  const profile = state.profileCache[state.currentUser] || {};
  const el = document.getElementById('profile-content');
  const avatarBig = profile.avatar_id
    ? `<img class="profile-avatar-big" src="${fileUrl('/api/files/' + profile.avatar_id)}" alt="">`
    : avatarHtml(state.currentUser, 80);

  el.innerHTML = `
    <div class="profile-card">
      <div class="profile-header">
        <div class="profile-avatar-wrap">${avatarBig}
          <label class="profile-avatar-upload" title="Upload avatar">
            &#x1F4F7;
            <input type="file" accept="image/*" onchange="uploadAvatar(this)" style="display:none;">
          </label>
        </div>
        <div class="profile-name-section">
          <div class="profile-username">${escapeHtml(state.currentUser)}</div>
        </div>
      </div>
      <div class="profile-field">
        <label class="profile-label">Status</label>
        <input type="text" id="profile-status-input" value="${escapeHtml(profile.status || '')}" maxlength="128" placeholder="What's on your mind?">
      </div>
      <div class="profile-field">
        <label class="profile-label">About</label>
        <textarea id="profile-about-input" maxlength="1024" rows="4" placeholder="Tell others about yourself">${escapeHtml(profile.about || '')}</textarea>
      </div>
      <div class="profile-edit-section">
        <button class="profile-save-btn" onclick="saveProfile()">Save</button>
        <button class="profile-cancel-btn" onclick="openProfile('${escapeHtml(state.currentUser)}')">Cancel</button>
      </div>
    </div>
  `;
}

export function saveProfile() {
  const statusInput = document.getElementById('profile-status-input');
  const aboutInput = document.getElementById('profile-about-input');
  const oldProfile = state.profileCache[state.currentUser] || {};

  if (statusInput && statusInput.value !== (oldProfile.status || '')) {
    send('UpdateProfile', { field: 'status', value: statusInput.value });
  }
  if (aboutInput && aboutInput.value !== (oldProfile.about || '')) {
    send('UpdateProfile', { field: 'about', value: aboutInput.value });
  }

  // Switch back to view mode
  openProfile(state.currentUser);
}

export async function uploadAvatar(input) {
  if (!input.files || !input.files[0]) return;
  const file = input.files[0];
  if (file.size > 2 * 1024 * 1024) {
    alert('Avatar must be under 2MB');
    return;
  }

  const formData = new FormData();
  formData.append('file', file);
  formData.append('channel', 'general');
  const resp = await fetch(apiUrl('/api/upload'), {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + state.token },
    body: formData,
  });
  const data = await resp.json();
  if (data.ok && data.file) {
    send('UpdateProfile', { field: 'avatar_id', value: data.file.id });
  } else {
    alert(data.error || 'Upload failed');
  }
}

// ── User Settings panel ──

export function openUserSettings() {
  const el = document.getElementById('user-settings-content');
  const profile = state.profileCache[state.currentUser] || {};
  const avatarBig = profile.avatar_id
    ? `<img class="profile-avatar-big" src="${fileUrl('/api/files/' + profile.avatar_id)}" alt="">`
    : avatarHtml(state.currentUser, 80);
  const statusVal = escapeHtml(profile.status || '');
  const aboutVal = escapeHtml(profile.about || '');

  // Notification prefs
  const prefs = state.notificationPrefs || {};
  const optionsHtml = (key) => {
    const val = prefs[key] || 'window';
    return ['window', 'system', 'none'].map(v =>
      `<option value="${v}"${v === val ? ' selected' : ''}>${v}</option>`
    ).join('');
  };

  el.innerHTML = `
    <div class="profile-card">
      <div class="profile-header">
        <div class="profile-avatar-wrap">${avatarBig}
          <label class="profile-avatar-upload" title="Upload avatar">
            &#x1F4F7;
            <input type="file" accept="image/*" onchange="uploadAvatar(this)" style="display:none;">
          </label>
        </div>
        <div class="profile-name-section">
          <div class="profile-username">${escapeHtml(state.currentUser)}</div>
        </div>
      </div>
      <div class="profile-field">
        <label class="profile-label">Status</label>
        <input type="text" id="settings-status-input" value="${statusVal}" maxlength="128" placeholder="What's on your mind?">
      </div>
      <div class="profile-field">
        <label class="profile-label">About</label>
        <textarea id="settings-about-input" maxlength="1024" rows="3" placeholder="Tell others about yourself">${aboutVal}</textarea>
      </div>
      <div class="profile-edit-section" style="margin-bottom:1rem;">
        <button class="profile-save-btn" onclick="saveUserSettings()">Save Profile</button>
      </div>
      <div style="border-top:1px solid var(--border);padding-top:0.8rem;">
        <div class="profile-label" style="margin-bottom:0.5rem;">Notifications</div>
        <div class="notif-setting"><label>@mention</label><select onchange="setNotifPref('notify_mention',this.value)">${optionsHtml('notify_mention')}</select></div>
        <div class="notif-setting"><label>@channel</label><select onchange="setNotifPref('notify_channel_mention',this.value)">${optionsHtml('notify_channel_mention')}</select></div>
        <div class="notif-setting"><label>@server</label><select onchange="setNotifPref('notify_server_mention',this.value)">${optionsHtml('notify_server_mention')}</select></div>
      </div>
    </div>
  `;
  document.getElementById('user-settings-overlay').classList.add('active');
  // Fetch fresh profile data
  send('GetProfile', { username: state.currentUser });
}

export function closeUserSettings() {
  document.getElementById('user-settings-overlay').classList.remove('active');
}

export function saveUserSettings() {
  const statusInput = document.getElementById('settings-status-input');
  const aboutInput = document.getElementById('settings-about-input');
  const oldProfile = state.profileCache[state.currentUser] || {};

  if (statusInput && statusInput.value !== (oldProfile.status || '')) {
    send('UpdateProfile', { field: 'status', value: statusInput.value });
  }
  if (aboutInput && aboutInput.value !== (oldProfile.about || '')) {
    send('UpdateProfile', { field: 'about', value: aboutInput.value });
  }

  closeUserSettings();
}

// ── Right-click context menu ──

export function initContextMenu() {
  const messagesEl = document.getElementById('messages');
  if (!messagesEl) return;

  // Create the context menu element
  const menu = document.createElement('div');
  menu.id = 'msg-context-menu';
  menu.className = 'msg-context-menu';
  menu.style.display = 'none';
  document.body.appendChild(menu);

  messagesEl.addEventListener('contextmenu', (e) => {
    const msgEl = e.target.closest('.msg[data-msg-id]');
    if (!msgEl) return;

    e.preventDefault();
    const msgId = msgEl.getAttribute('data-msg-id');
    const author = msgEl.getAttribute('data-author');
    const isOwn = author === state.currentUser;
    const canPin = state.isAdmin || (state.channelCreators && state.channelCreators[state.currentChannel] === state.currentUser);
    const isPinned = !!msgEl.querySelector('.pinned-badge');
    const isEncrypted = state.encryptedChannels.has(state.currentChannel);

    const quickEmojis = ['👍', '❤️', '😂', '😮', '😢', '🔥', '👀'];
    let items = '';
    if (!isEncrypted) {
      items += `<div class="ctx-quick-react">${quickEmojis.map(e =>
        `<button class="ctx-react-emoji" data-emoji="${e}">${e}</button>`
      ).join('')}</div>`;
    }
    items += `<div class="ctx-item" data-action="reply">Reply</div>`;
    if (!isEncrypted) items += `<div class="ctx-item" data-action="react">React...</div>`;
    if (canPin) items += `<div class="ctx-item" data-action="pin">${isPinned ? 'Unpin' : 'Pin'}</div>`;
    if (isOwn) items += `<div class="ctx-item" data-action="edit">Edit</div>`;
    if (isOwn || state.isAdmin) items += `<div class="ctx-item ctx-danger" data-action="delete">Delete</div>`;

    menu.innerHTML = items;
    menu.style.display = 'block';

    // Position near click, but keep on screen
    const x = Math.min(e.clientX, window.innerWidth - 160);
    const y = Math.min(e.clientY, window.innerHeight - menu.offsetHeight - 10);
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';

    const handleAction = (ev) => {
      // Quick-react emoji buttons
      const emojiBtn = ev.target.closest('.ctx-react-emoji');
      if (emojiBtn) {
        menu.style.display = 'none';
        send('AddReaction', { message_id: msgId, emoji: emojiBtn.getAttribute('data-emoji') });
        return;
      }

      const item = ev.target.closest('.ctx-item');
      if (!item) return;
      menu.style.display = 'none';
      const action = item.getAttribute('data-action');
      switch (action) {
        case 'reply': window.startReply(msgId); break;
        case 'react': {
          // Open full reaction picker anchored to the message
          const reactBtn = msgEl.querySelector('.react-btn');
          if (reactBtn) {
            reactBtn.click();
          } else {
            openReactionPicker(msgEl, (emoji) => {
              send('AddReaction', { message_id: msgId, emoji });
            });
          }
          break;
        }
        case 'pin': window.togglePinMessage(msgId); break;
        case 'edit': window.startEditMessage(msgId); break;
        case 'delete': window.deleteMessage(msgId); break;
      }
    };

    menu.onclick = handleAction;
  });

  // Dismiss on click elsewhere or Escape
  document.addEventListener('click', (e) => {
    if (!menu.contains(e.target)) menu.style.display = 'none';
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') menu.style.display = 'none';
  });
}

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

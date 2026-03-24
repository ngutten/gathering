// chat-ui.js — Message rendering, channel list, online users, DMs, typing

import state, { isDMChannel, emit, serverHas } from './state.js';
import { send } from './transport.js';
import { escapeHtml, renderRichContent, formatFileSize, isImageMime, isAudioMime, isVideoMime, renderAttachmentsHtml, decryptAndRenderAttachments, renderTtlBadge, renderEncryptedBadge } from './render.js';
import { tryDecrypt, getKeyFingerprint, generateChannelKey, encryptChannelKeyForUser, generateE2EKey, importPrivateKey } from './crypto.js';
import { apiUrl, fileUrl } from './config.js';
import { openReactionPicker, closeReactionPicker } from './emoji.js';
import { scopedGet, scopedSet } from './storage.js';

const TYPING_INDICATOR_TIMEOUT_MS = 3000;
const CHANNEL_SETTINGS_REFRESH_DELAY_MS = 300;
const MSG_GROUP_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

// ── Build action buttons HTML for a message ──

function buildMsgActionsHtml(msg) {
  const isOwn = msg.author === state.currentUser;
  const canPin = state.isAdmin || (state.channelCreators && state.channelCreators[msg.channel || state.currentChannel] === state.currentUser);
  const isEncrypted = state.encryptedChannels.has(msg.channel || state.currentChannel);
  const isAnon = state.channelAnonymous[msg.channel || state.currentChannel];
  let html = '<div class="msg-actions" role="toolbar" aria-label="Message actions">';
  if (!isEncrypted) html += `<button class="react-btn" data-msg-id="${msg.id}" aria-label="Add reaction">+&#x1F600;</button>`;
  html += `<button onclick="startReply('${msg.id}')" aria-label="Reply">reply</button>`;
  if (canPin) html += `<button onclick="togglePinMessage('${msg.id}')" aria-label="${msg.pinned ? 'Unpin' : 'Pin'} message">${msg.pinned ? 'unpin' : 'pin'}</button>`;
  if (isOwn && !isAnon) html += `<button onclick="startEditMessage('${msg.id}')" aria-label="Edit message">edit</button>`;
  if (isAnon ? state.isAdmin : (isOwn || state.isAdmin)) html += `<button class="del-btn" onclick="deleteMessage('${msg.id}')" aria-label="Delete message">del</button>`;
  if (!isOwn) html += `<button onclick="hideMessage('${msg.id}')" aria-label="Hide message">hide</button>`;
  html += '</div>';
  return html;
}

// Rebuild action buttons on all visible messages (called after AuthResult sets currentUser)
export function refreshAllMessageActions() {
  document.querySelectorAll('#messages .msg').forEach(div => {
    const msgId = div.getAttribute('data-msg-id');
    const author = div.getAttribute('data-author');
    const channel = div.getAttribute('data-channel') || state.currentChannel;
    const pinned = div.querySelector('.pinned-badge') !== null;
    if (!msgId || !author) return;
    const oldActions = div.querySelector('.msg-actions');
    if (!oldActions) return;
    const newHtml = buildMsgActionsHtml({ id: msgId, author, channel, pinned });
    const tmp = document.createElement('div');
    tmp.innerHTML = newHtml;
    const newActions = tmp.firstElementChild;
    oldActions.replaceWith(newActions);
    // Re-wire the reaction picker button (handler was lost during DOM replacement)
    const reactBtn = newActions.querySelector('.react-btn');
    if (reactBtn) {
      reactBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openReactionPicker(reactBtn, (emoji) => {
          send('AddReaction', { message_id: msgId, emoji });
        });
      });
    }
  });
}

// ── Accessibility: modal focus management ──

let _previousFocus = null;

function openOverlay(overlayId) {
  _previousFocus = document.activeElement;
  const overlay = document.getElementById(overlayId);
  if (overlay) {
    overlay.classList.add('active');
    // Focus the first focusable element inside the panel
    requestAnimationFrame(() => {
      const focusable = overlay.querySelector('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
      if (focusable) focusable.focus();
    });
  }
}

function closeOverlay(overlayId) {
  const overlay = document.getElementById(overlayId);
  if (overlay) overlay.classList.remove('active');
  if (_previousFocus && _previousFocus.focus) {
    _previousFocus.focus();
    _previousFocus = null;
  }
}

// Global Escape key handler for all overlays
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const overlays = [
    { id: 'create-channel-overlay', close: 'closeCreateChannel' },
    { id: 'user-settings-overlay', close: 'closeUserSettings' },
    { id: 'profile-overlay', close: 'closeProfile' },
    { id: 'admin-overlay', close: 'closeAdminPanel' },
    { id: 'channel-settings-overlay', close: 'closeChannelSettings' },
    { id: 'pinned-messages-overlay', close: 'closePinnedPanel' },
  ];
  for (const { id, close } of overlays) {
    const el = document.getElementById(id);
    if (el && el.classList.contains('active')) {
      if (window[close]) window[close]();
      e.stopPropagation();
      return;
    }
  }
});

// ── Create Channel Dialog ──

let _createChannelType = 'text';

export function openCreateChannel(type) {
  _createChannelType = type || 'text';
  const isVoice = _createChannelType === 'voice';
  document.getElementById('create-channel-title').textContent = isVoice ? 'Create Voice Channel' : 'Create Channel';

  const content = document.getElementById('create-channel-content');
  let html = '<div class="create-channel-form">';
  html += '<input type="text" id="create-channel-name" placeholder="channel-name" autocomplete="off"' +
          ' onkeydown="if(event.key===\'Enter\'){event.preventDefault();submitCreateChannel();}">';

  if (!isVoice) {
    html += '<label class="create-channel-toggle"><span>Encrypted (E2E)</span>' +
            '<input type="checkbox" id="create-channel-encrypted" style="width:14px;height:14px;accent-color:var(--accent);cursor:pointer;"></label>' +
            '<div class="create-channel-toggle-desc">Messages encrypted end-to-end. Requires an E2E key.</div>';
    html += '<label class="create-channel-toggle"><span>Restricted</span>' +
            '<input type="checkbox" id="create-channel-restricted" style="width:14px;height:14px;accent-color:var(--accent);cursor:pointer;"></label>' +
            '<div class="create-channel-toggle-desc">Only invited members can access.</div>';
  }

  html += '<div style="display:flex;gap:0.5rem;justify-content:flex-end;margin-top:0.2rem;">' +
          '<button class="btn-secondary" onclick="closeCreateChannel()" style="padding:0.4rem 1rem;border-radius:4px;font-family:inherit;font-size:0.8rem;cursor:pointer;">Cancel</button>' +
          '<button class="btn-primary" onclick="submitCreateChannel()" style="padding:0.4rem 1rem;border-radius:4px;font-family:inherit;font-size:0.8rem;cursor:pointer;">Create</button>' +
          '</div></div>';

  content.innerHTML = html;
  openOverlay('create-channel-overlay');
  setTimeout(() => document.getElementById('create-channel-name')?.focus(), 50);
}

export function closeCreateChannel() {
  closeOverlay('create-channel-overlay');
}

export function submitCreateChannel() {
  const input = document.getElementById('create-channel-name');
  if (!input) return;
  let name = input.value.trim().replace(/^#/, '').toLowerCase().replace(/[^a-z0-9_-]/g, '');
  if (!name || isDMChannel(name)) return;

  if (_createChannelType === 'voice') {
    import('./voice.js').then(m => m.createVoiceChannel(name));
    closeCreateChannel();
    return;
  }

  // Text channel
  const encCheck = document.getElementById('create-channel-encrypted');
  const restrictCheck = document.getElementById('create-channel-restricted');
  const wantEncrypted = encCheck && encCheck.checked;
  const wantRestricted = restrictCheck && restrictCheck.checked;

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

  if (wantRestricted) {
    setTimeout(() => send('SetChannelRestricted', { channel: name, restricted: true }), 300);
  }

  closeCreateChannel();
  switchChannel(name);
}


export function appendMessage(msg) {
  if (msg.channel && msg.channel !== state.currentChannel) return;

  const el = document.getElementById('messages');
  const div = document.createElement('div');
  div.className = 'msg';
  div.setAttribute('data-msg-id', msg.id);
  div.setAttribute('data-author', msg.author);
  div.setAttribute('data-timestamp', msg.timestamp);
  if (msg.expires_at) div.setAttribute('data-expires-at', msg.expires_at);

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
  const actionsHtml = buildMsgActionsHtml(msg);


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

function updateSidebarActiveClasses() {
  document.querySelectorAll('#channel-list .channel-item, #dm-list .dm-item').forEach(el => {
    el.classList.toggle('active', el.dataset.channel === state.currentChannel);
  });
}

export function renderChannels() {
  state.channels.forEach(ch => {
    if (ch.encrypted) state.encryptedChannels.add(ch.name);
    if (ch.created_by) state.channelCreators[ch.name] = ch.created_by;
    // Populate ghost/anon state from ChannelInfo
    state.channelForceGhost[ch.name] = !!ch.force_ghost;
    state.channelMaxTtl[ch.name] = ch.max_ttl_secs ?? null;
    state.channelAnonymous[ch.name] = !!ch.anonymous;
  });

  // Separate text and voice channels
  const textChannels = state.channels.filter(ch => !isDMChannel(ch.name) && ch.channel_type !== 'voice');
  const voiceChannels = state.channels.filter(ch => ch.channel_type === 'voice');
  state.voiceChannels = voiceChannels;

  // Render text channels
  const el = document.getElementById('channel-list');

  // Skip DOM rebuild if focus is inside — avoids stealing focus mid-tab
  if (document.activeElement && el.contains(document.activeElement)) {
    updateSidebarActiveClasses();
    renderVoiceChannelList();
    updateGhostButton();
    return;
  }

  el.innerHTML = textChannels.map(ch => {
    const lock = ch.encrypted ? '&#x1F512; ' : ch.anonymous ? '&#x1F3AD; ' : ch.restricted ? '&#x1F6E1; ' : '#';
    const unread = state.unreadCounts[ch.name] || 0;
    const hasMention = state.unreadMentions[ch.name];
    const badgeClass = hasMention ? 'unread-badge unread-mention' : 'unread-badge';
    const unreadBadge = unread > 0 ? `<span class="${badgeClass}">${unread > 99 ? '99+' : unread}</span>` : '';
    const boldClass = unread > 0 ? ' has-unread' : '';
    let keyClass = '';
    if (ch.encrypted && !state.e2eReady) {
      keyClass = ' no-e2e-key';
    } else if (ch.encrypted && state.e2eReady && ch.has_key === false) {
      keyClass = ' no-channel-key';
    }
    return `<div class="channel-item${boldClass}${keyClass} ${ch.name === state.currentChannel ? 'active' : ''}"
         onclick="switchChannel('${escapeHtml(ch.name)}')" tabindex="0" role="button" data-channel="${escapeHtml(ch.name)}"
         aria-label="${escapeHtml(ch.name)} channel${unread > 0 ? ', ' + unread + ' unread' : ''}"
         onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();if('${escapeHtml(ch.name)}'===window._gatheringState.currentChannel){var r=this.getBoundingClientRect();this.dispatchEvent(new MouseEvent('contextmenu',{clientX:r.left+20,clientY:r.bottom,bubbles:true}));}else{switchChannel('${escapeHtml(ch.name)}');}}">
      <span>${lock}${escapeHtml(ch.name)}</span>
      <span class="channel-right">${unreadBadge}<span class="count">${ch.user_count}</span></span>
    </div>`;
  }).join('');
  updateGhostButton();

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
      <div class="voice-channel-header" onclick="switchChannel('${escapeHtml(ch.name)}')" tabindex="0" role="button"
           aria-label="Voice channel ${escapeHtml(ch.name)}${unread > 0 ? ', ' + unread + ' unread' : ''}"
           onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();switchChannel('${escapeHtml(ch.name)}');}">
        <span class="voice-channel-name">&#x1F50A; ${escapeHtml(ch.name)}</span>
        <span class="channel-right">${unreadBadge}</span>
      </div>`;

    // Show occupants
    if (occupants.length > 0) {
      html += '<div class="voice-channel-occupants">';
      occupants.forEach(u => {
        html += `<div class="voice-channel-user"><span class="voice-dot" aria-hidden="true"></span>${escapeHtml(u)}</div>`;
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

  // Skip DOM rebuild if focus is inside the user list — the profile
  // response will trigger another render once data is cached anyway
  if (document.activeElement && el.contains(document.activeElement)) {
    return;
  }

  el.innerHTML = users.map(u => {
    const dmBtn = u !== state.currentUser ?
      `<button class="dm-btn" onclick="startDM('${escapeHtml(u)}')" title="Message ${escapeHtml(u)}" aria-label="Direct message ${escapeHtml(u)}">&#x2709;</button>` : '';
    const profile = state.profileCache[u] || {};
    const statusHtml = profile.status ? `<span class="user-item-status" title="${escapeHtml(profile.status)}">${escapeHtml(profile.status)}</span>` : '';
    return `<div class="user-item" data-username="${escapeHtml(u)}">
      <span class="user-item-name" onclick="openProfile('${escapeHtml(u)}')" style="cursor:pointer;" tabindex="0" role="button"
            aria-label="View profile for ${escapeHtml(u)}"
            onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();openProfile('${escapeHtml(u)}');}">
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

  // Skip DOM rebuild if focus is inside — avoids stealing focus mid-tab
  if (document.activeElement && el.contains(document.activeElement)) {
    updateSidebarActiveClasses();
    return;
  }

  el.innerHTML = entries.map(([ch, other]) => {
    const unread = state.unreadCounts[ch] || 0;
    const hasMention = state.unreadMentions[ch];
    const badgeClass = hasMention ? 'unread-badge unread-mention' : 'unread-badge';
    const unreadBadge = unread > 0 ? `<span class="${badgeClass}">${unread > 99 ? '99+' : unread}</span>` : '';
    const boldClass = unread > 0 ? ' has-unread' : '';
    let dmKeyClass = '';
    if (!state.e2eReady) {
      dmKeyClass = ' no-e2e-key';
    } else if (!state.channelKeys[ch]) {
      dmKeyClass = ' no-channel-key';
    }
    return `<div class="dm-item${boldClass}${dmKeyClass} ${ch === state.currentChannel ? 'active' : ''}" onclick="switchChannel('${escapeHtml(ch)}')" tabindex="0" role="button" data-channel="${escapeHtml(ch)}"
         aria-label="Direct message with ${escapeHtml(other)}${unread > 0 ? ', ' + unread + ' unread' : ''}"
         onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();switchChannel('${escapeHtml(ch)}');}">
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

  // Anonymous channel toggle
  if (canManage) {
    const isAnon = state.channelAnonymous[msg.channel];
    html += `<div style="margin-top:0.5rem;padding-top:0.5rem;border-top:1px solid var(--border);">
      <label style="font-size:0.75rem;cursor:pointer;">
        <input type="checkbox" ${isAnon ? 'checked' : ''} onchange="toggleChannelAnonymous('${escapeHtml(msg.channel)}', this.checked)">
        Anonymous mode (hide authors)
      </label>
    </div>`;
  }

  // Ghost mode (force) + max TTL
  if (canManage) {
    const isForceGhost = state.channelForceGhost[msg.channel];
    const maxTtl = state.channelMaxTtl[msg.channel];
    html += `<div style="margin-top:0.5rem;padding-top:0.5rem;border-top:1px solid var(--border);">
      <label style="font-size:0.75rem;cursor:pointer;">
        <input type="checkbox" ${isForceGhost ? 'checked' : ''} onchange="toggleChannelGhost('${escapeHtml(msg.channel)}', this.checked)">
        Force ghost mode (messages auto-expire)
      </label>
      <div style="margin-top:0.3rem;">
        <label style="font-size:0.7rem;color:var(--text2);">Max TTL:
          <select style="font-size:0.75rem;background:var(--bg);border:1px solid var(--border);color:var(--text);border-radius:3px;padding:0.15rem;" onchange="setChannelMaxTtl('${escapeHtml(msg.channel)}', this.value)">
            <option value="">No limit</option>
            <option value="300" ${maxTtl === 300 ? 'selected' : ''}>5 minutes</option>
            <option value="3600" ${maxTtl === 3600 ? 'selected' : ''}>1 hour</option>
            <option value="86400" ${maxTtl === 86400 ? 'selected' : ''}>1 day</option>
            <option value="604800" ${maxTtl === 604800 ? 'selected' : ''}>7 days</option>
          </select>
        </label>
      </div>
    </div>`;
  }

  // Re-key button for encrypted channels
  if (state.encryptedChannels.has(msg.channel) && state.channelKeys[msg.channel]) {
    html += `<div style="margin-top:0.7rem;padding-top:0.5rem;border-top:1px solid var(--border);">
      <div style="font-size:0.7rem;color:var(--red);margin-bottom:0.3rem;">Danger Zone</div>
      <button class="admin-btn-sm danger" onclick="rekeyChannel('${escapeHtml(msg.channel)}')" title="All existing messages will become permanently unreadable">Re-key Channel</button>
    </div>`;
  }

  content.innerHTML = html;
  openOverlay('channel-settings-overlay');
}

export function openChannelSettings() {
  if (!state.currentChannel || state.currentChannel === 'general') return;
  send('GetChannelMembers', { channel: state.currentChannel });
}

export function closeChannelSettings() {
  closeOverlay('channel-settings-overlay');
}

export function toggleChannelRestricted(channel, restricted) {
  send('SetChannelRestricted', { channel, restricted });
  // Refresh the member list after a short delay
  setTimeout(() => send('GetChannelMembers', { channel }), CHANNEL_SETTINGS_REFRESH_DELAY_MS);
}

export function toggleChannelAnonymous(channel, anonymous) {
  send('SetChannelAnonymous', { channel, anonymous });
  setTimeout(() => send('GetChannelMembers', { channel }), CHANNEL_SETTINGS_REFRESH_DELAY_MS);
}

export function toggleChannelGhost(channel, forceGhost) {
  send('SetChannelGhost', { channel, force_ghost: forceGhost });
  setTimeout(() => send('GetChannelMembers', { channel }), CHANNEL_SETTINGS_REFRESH_DELAY_MS);
}

export function setChannelMaxTtl(channel, value) {
  const maxTtl = value ? parseInt(value) : null;
  send('SetChannelMaxTtl', { channel, max_ttl_secs: maxTtl });
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

/**
 * Show a dialog prompting the user to generate/import an E2E key or go back.
 * Only shown when the user actively navigates to an encrypted context without a key.
 */
export function showE2EKeyPrompt(onAbort) {
  const existing = document.getElementById('e2e-key-prompt-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'e2e-key-prompt-overlay';
  overlay.className = 'admin-overlay active';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.innerHTML = `
    <div class="admin-panel" style="width:380px;">
      <div class="admin-panel-header">
        <h2>Encryption Key Required</h2>
      </div>
      <div class="admin-tab-content">
        <div style="margin-bottom:1rem;font-size:0.85rem;color:var(--text2);">
          This channel uses end-to-end encryption. You need an E2E key to participate.
        </div>
        <div style="display:flex;gap:0.5rem;flex-wrap:wrap;">
          <button class="profile-save-btn" id="e2e-prompt-generate">Generate Key</button>
          <button class="profile-edit-btn" id="e2e-prompt-import">Import Key</button>
          <button class="profile-edit-btn" id="e2e-prompt-abort" style="border-color:var(--text2);color:var(--text2);">Go Back</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const close = () => overlay.remove();

  document.getElementById('e2e-prompt-generate').onclick = () => {
    close();
    generateE2EKey(false);
    // Auto-request channel key now that we have an E2E key
    const ch = state.currentChannel;
    if (state.encryptedChannels.has(ch) && !state.channelKeys[ch]) {
      send('RequestChannelKey', { channel: ch });
    }
    updateRequestKeyButton();
  };

  document.getElementById('e2e-prompt-import').onclick = () => {
    close();
    importPrivateKey();
    // importPrivateKey is async (file picker) — poll for completion
    const ch = state.currentChannel;
    const check = setInterval(() => {
      if (state.e2eReady) {
        clearInterval(check);
        if (state.encryptedChannels.has(ch) && !state.channelKeys[ch]) {
          send('RequestChannelKey', { channel: ch });
        }
        updateRequestKeyButton();
      }
    }, 200);
    setTimeout(() => clearInterval(check), 30000);
  };

  document.getElementById('e2e-prompt-abort').onclick = () => {
    close();
    if (onAbort) onAbort();
  };

  overlay.onclick = (e) => {
    if (e.target === overlay) {
      close();
      if (onAbort) onAbort();
    }
  };
}

export function switchChannel(name) {
  const prev = state.currentChannel;
  const prevView = state.currentView;
  const prevTopicId = state.currentTopicId;
  state.currentChannel = name;
  state.currentTopicId = null;
  // Track channel navigation for browser back button
  if (!state._skipHistoryPush && (prev !== name || prevView !== 'chat')) {
    state.channelHistory.push({ type: 'channel', channel: prev, view: prevView, topicId: prevTopicId });
    try { history.pushState({ channel: name, view: 'chat' }, '', ''); } catch(e) {}
  }
  state._skipHistoryPush = false;
  state.topicsList = [];
  // Clear unread for this channel
  state.unreadCounts[name] = 0;
  delete state.unreadMentions[name];
  state.lastReadTimestamps[name] = new Date().toISOString();
  try { scopedSet('last_read_' + name, state.lastReadTimestamps[name]); } catch(e) {}
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
  // Show/hide anonymous banner
  const anonBanner = document.getElementById('anon-banner');
  if (anonBanner) anonBanner.style.display = state.channelAnonymous[name] ? '' : 'none';
  // Update ghost button state
  updateGhostButton();
  // Disable widgets on encrypted channels (data leak risk)
  const widgetBtn = document.getElementById('widget-toolbar-btn');
  if (widgetBtn) {
    const encrypted = state.encryptedChannels.has(name);
    widgetBtn.classList.toggle('disabled', encrypted);
    widgetBtn.style.opacity = encrypted ? '0.35' : '';
    widgetBtn.style.pointerEvents = encrypted ? 'none' : '';
    widgetBtn.title = encrypted ? 'Widgets are not available on encrypted channels' : '';
  }
  // Import switchView dynamically to avoid circular deps
  // Suppress history push — the channel switch already recorded it
  import('./topics.js').then(m => { state._skipHistoryPush = true; m.switchView('chat'); });
  // Always send Join — server is idempotent (skips broadcast if already joined)
  // and responds with history + channel key delivery
  send('Join', { channel: name });
  // Emit after Join so the server has registered us in the channel
  // before widget presence requests are sent
  emit('channel-switched', name);
  if (state.encryptedChannels.has(name) && !state.e2eReady) {
    if (state._suppressE2EPrompt) {
      state._suppressE2EPrompt = false;
    } else {
      showE2EKeyPrompt(() => switchChannel(prev || 'general'));
    }
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

// ── Ghost mode ──

const TTL_OPTIONS = [
  { value: 60, label: '1 minute' },
  { value: 300, label: '5 minutes' },
  { value: 3600, label: '1 hour' },
  { value: 86400, label: '1 day' },
  { value: 604800, label: '7 days' },
];

function formatTtlShort(secs) {
  if (secs >= 604800) return `${Math.round(secs / 604800)}d`;
  if (secs >= 86400) return `${Math.round(secs / 86400)}d`;
  if (secs >= 3600) return `${Math.round(secs / 3600)}h`;
  if (secs >= 60) return `${Math.round(secs / 60)}m`;
  return `${secs}s`;
}

export function updateGhostButton() {
  ['ghost-btn', 'topic-ghost-btn', 'reply-ghost-btn'].forEach(btnId => {
    const btn = document.getElementById(btnId);
    if (!btn) return;
    const ch = state.currentChannel;
    const forced = state.channelForceGhost[ch];
    const active = state.ghostMode || forced;
    btn.classList.toggle('active', active && !forced);
    btn.classList.toggle('forced', !!forced);
    const effectiveTtl = state.channelMaxTtl[ch] != null
      ? Math.min(state.ghostTtl, state.channelMaxTtl[ch])
      : state.ghostTtl;
    if (forced) {
      btn.title = `Ghost mode forced (${formatTtlShort(state.channelMaxTtl[ch] || 86400)})`;
    } else if (state.ghostMode) {
      btn.title = `Ghost mode ON (${formatTtlShort(effectiveTtl)}) — click to toggle, right-click for options`;
    } else {
      btn.title = 'Ghost mode OFF — click to toggle, right-click for options';
    }
  });
}

export function getEffectiveGhostTtl() {
  const ch = state.currentChannel;
  const forced = state.channelForceGhost[ch];
  const active = state.ghostMode || forced;
  if (!active) return null;
  const ttl = state.ghostTtl;
  const maxTtl = state.channelMaxTtl[ch];
  if (maxTtl != null) return Math.min(ttl, maxTtl);
  return ttl;
}

export function initGhostButtons() {
  ['ghost-btn', 'topic-ghost-btn', 'reply-ghost-btn'].forEach(btnId => {
    const btn = document.getElementById(btnId);
    if (!btn) return;
    btn.addEventListener('click', (e) => {
      if (state.channelForceGhost[state.currentChannel]) return; // can't toggle forced
      state.ghostMode = !state.ghostMode;
      try { scopedSet('ghost_mode', state.ghostMode ? '1' : '0'); } catch(e) {}
      updateGhostButton();
    });
    btn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showGhostPopover(btn);
    });
  });
  // Load persisted ghost state
  try {
    const saved = localStorage.getItem('gathering_ghost_mode');
    if (saved === '1') state.ghostMode = true;
    const savedTtl = localStorage.getItem('gathering_ghost_ttl');
    if (savedTtl) state.ghostTtl = parseInt(savedTtl) || 86400;
  } catch(e) {}
  updateGhostButton();
}

function showGhostPopover(anchorBtn) {
  // Close existing
  const existing = document.querySelector('.ghost-popover');
  if (existing) { existing.remove(); return; }

  const pop = document.createElement('div');
  pop.className = 'ghost-popover';
  pop.innerHTML = TTL_OPTIONS.map(opt =>
    `<label><input type="radio" name="ghost-ttl" value="${opt.value}" ${state.ghostTtl === opt.value ? 'checked' : ''}> ${opt.label}</label>`
  ).join('');
  pop.querySelectorAll('input').forEach(input => {
    input.addEventListener('change', () => {
      state.ghostTtl = parseInt(input.value);
      try { localStorage.setItem('gathering_ghost_ttl', String(state.ghostTtl)); } catch(e) {}
      send('SetPreference', { key: 'ghost_ttl', value: String(state.ghostTtl) });
      if (!state.ghostMode && !state.channelForceGhost[state.currentChannel]) {
        state.ghostMode = true;
        try { localStorage.setItem('gathering_ghost_mode', '1'); } catch(e) {}
      }
      updateGhostButton();
      pop.remove();
    });
  });
  // Position relative to button
  anchorBtn.style.position = 'relative';
  anchorBtn.appendChild(pop);
  // Close on click outside
  const closeHandler = (e) => {
    if (!pop.contains(e.target) && e.target !== anchorBtn) {
      pop.remove();
      document.removeEventListener('click', closeHandler);
    }
  };
  setTimeout(() => document.addEventListener('click', closeHandler), 0);
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
  closeOverlay('pinned-messages-overlay');
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
    return `<img class="user-avatar" src="${url}" alt="${escapeHtml(username)}'s avatar" style="width:${sz}px;height:${sz}px;border-radius:50%;object-fit:cover;">`;
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
  openOverlay('profile-overlay');
}

export function closeProfile() {
  closeOverlay('profile-overlay');
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

// ── PFP user menu ──

export function initUserPFP() {
  const avatarEl = document.getElementById('user-pfp-avatar');
  if (avatarEl && state.currentUser) {
    avatarEl.innerHTML = avatarHtml(state.currentUser, 28);
  }
  const nameEl = document.getElementById('user-bar-name');
  if (nameEl && state.currentUser) {
    nameEl.textContent = state.currentUser;
  }
}

export function toggleUserMenu() {
  const dropdown = document.getElementById('user-pfp-dropdown');
  const btn = document.getElementById('user-pfp-btn');
  if (!dropdown) return;
  const visible = dropdown.style.display !== 'none';
  if (visible) {
    closeUserMenu();
  } else {
    // Populate dynamic content
    const adminItem = document.getElementById('pfp-admin-item');
    if (adminItem) adminItem.style.display = state.isAdmin ? '' : 'none';
    dropdown.style.display = 'block';
    if (btn) btn.setAttribute('aria-expanded', 'true');
    // Focus first menu item
    const firstItem = dropdown.querySelector('[role="menuitem"]');
    if (firstItem) firstItem.focus();
  }
}

export function closeUserMenu() {
  const dropdown = document.getElementById('user-pfp-dropdown');
  const btn = document.getElementById('user-pfp-btn');
  if (dropdown) dropdown.style.display = 'none';
  if (btn) btn.setAttribute('aria-expanded', 'false');
}

// Click-outside listener for PFP menu
document.addEventListener('click', (e) => {
  const wrap = document.querySelector('.user-pfp-menu-wrap');
  if (wrap && !wrap.contains(e.target)) closeUserMenu();
});

// Keyboard navigation for PFP dropdown
document.addEventListener('keydown', (e) => {
  const dropdown = document.getElementById('user-pfp-dropdown');
  if (!dropdown || dropdown.style.display === 'none') return;
  const items = [...dropdown.querySelectorAll('[role="menuitem"]')].filter(i => i.style.display !== 'none');
  const idx = items.indexOf(document.activeElement);
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    items[(idx + 1) % items.length].focus();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    items[(idx - 1 + items.length) % items.length].focus();
  } else if (e.key === 'Escape') {
    closeUserMenu();
    const btn = document.getElementById('user-pfp-btn');
    if (btn) btn.focus();
  } else if (e.key === 'Enter' && idx >= 0) {
    e.preventDefault();
    items[idx].click();
  }
});

// ── User Settings panel (tabbed) ──

let _currentSettingsTab = 'profile';

export function openUserSettings(tab) {
  _currentSettingsTab = tab || 'profile';
  // Activate correct tab button
  const tabBar = document.getElementById('user-settings-tabs');
  if (tabBar) {
    tabBar.querySelectorAll('button').forEach(btn => {
      btn.classList.toggle('active', btn.textContent.toLowerCase() === _currentSettingsTab);
    });
  }
  renderUserSettingsTab(_currentSettingsTab);
  openOverlay('user-settings-overlay');
  send('GetProfile', { username: state.currentUser });
}

export function switchUserSettingsTab(tab, btn) {
  // If leaving files tab, clear file manager state
  if (_currentSettingsTab === 'files' && tab !== 'files') {
    state.fileManagerOpen = false;
  }
  _currentSettingsTab = tab;
  const tabBar = document.getElementById('user-settings-tabs');
  if (tabBar) {
    tabBar.querySelectorAll('button').forEach(b => b.classList.remove('active'));
  }
  if (btn) btn.classList.add('active');
  renderUserSettingsTab(tab);
}

function renderUserSettingsTab(tab) {
  const el = document.getElementById('user-settings-content');
  if (!el) return;
  switch (tab) {
    case 'profile': renderProfileTab(el); break;
    case 'chat': renderChatTab(el); break;
    case 'notifications': renderNotificationsTab(el); break;
    case 'files': renderFilesTab(el); break;
    case 'voice': renderVoiceTab(el); break;
    case 'encryption': renderEncryptionTab(el); break;
  }
}

function renderChatTab(el) {
  const ttlOpts = TTL_OPTIONS.map(opt =>
    `<label style="display:block;padding:0.2rem 0;cursor:pointer;"><input type="radio" name="settings-ghost-ttl" value="${opt.value}" ${state.ghostTtl === opt.value ? 'checked' : ''} onchange="setGhostTtlFromSettings(${opt.value})"> ${opt.label}</label>`
  ).join('');
  el.innerHTML = `
    <div class="profile-card">
      <div class="profile-label" style="margin-bottom:0.5rem;">Ghost Mode</div>
      <div style="font-size:0.8rem;color:var(--text2);margin-bottom:0.5rem;">
        When active, your messages will automatically expire after the selected duration.
        Channel admins can also force ghost mode on specific channels.
      </div>
      <label style="display:block;margin-bottom:0.6rem;cursor:pointer;font-size:0.85rem;">
        <input type="checkbox" id="settings-ghost-toggle" ${state.ghostMode ? 'checked' : ''} onchange="toggleGhostFromSettings(this.checked)">
        Enable ghost mode by default
      </label>
      <div class="profile-label" style="margin-bottom:0.3rem;">Default expiry duration</div>
      ${ttlOpts}
    </div>
  `;
}

function renderProfileTab(el) {
  const profile = state.profileCache[state.currentUser] || {};
  const avatarBig = profile.avatar_id
    ? `<img class="profile-avatar-big" src="${fileUrl('/api/files/' + profile.avatar_id)}" alt="">`
    : avatarHtml(state.currentUser, 80);
  const statusVal = escapeHtml(profile.status || '');
  const aboutVal = escapeHtml(profile.about || '');

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
      <div class="profile-edit-section">
        <button class="profile-save-btn" onclick="saveUserSettings()">Save Profile</button>
      </div>
    </div>
  `;
}

function renderNotificationsTab(el) {
  const prefs = state.notificationPrefs || {};
  const optionsHtml = (key) => {
    const val = prefs[key] || 'window';
    return ['window', 'system', 'none'].map(v =>
      `<option value="${v}"${v === val ? ' selected' : ''}>${v}</option>`
    ).join('');
  };

  const dmVal = prefs.allow_dms || 'everyone';
  el.innerHTML = `
    <div class="profile-card">
      <div class="profile-label" style="margin-bottom:0.5rem;">Notification Preferences</div>
      <div class="notif-setting"><label>@mention</label><select onchange="setNotifPref('notify_mention',this.value)">${optionsHtml('notify_mention')}</select></div>
      <div class="notif-setting"><label>@channel</label><select onchange="setNotifPref('notify_channel_mention',this.value)">${optionsHtml('notify_channel_mention')}</select></div>
      <div class="notif-setting"><label>@server</label><select onchange="setNotifPref('notify_server_mention',this.value)">${optionsHtml('notify_server_mention')}</select></div>
      <div class="notif-setting"><label>Sound</label><select onchange="setNotifPref('notify_sound',this.value)">${['on','off'].map(v => `<option value="${v}"${v === (prefs.notify_sound || 'on') ? ' selected' : ''}>${v}</option>`).join('')}</select></div>
    </div>
    <div class="profile-card" style="margin-top:0.8rem;">
      <div class="profile-label" style="margin-bottom:0.5rem;">Privacy</div>
      <div class="notif-setting"><label>Allow DMs</label><select onchange="setNotifPref('allow_dms',this.value)">${['everyone','none'].map(v => `<option value="${v}"${v === dmVal ? ' selected' : ''}>${v}</option>`).join('')}</select></div>
    </div>
  `;
}

function renderFilesTab(el) {
  el.innerHTML = '<div id="files-content"><div style="color:var(--text2);font-size:0.8rem;">Loading files...</div></div>';
  state.fileManagerOpen = true;
  send('ListMyFiles');
}

function renderVoiceTab(el) {
  const rnnoiseOn = scopedGet('rnnoise_enabled') !== 'false'; // default on
  el.innerHTML = `
    <div class="profile-card">
      <div class="profile-label" style="margin-bottom:0.5rem;">Noise Suppression</div>
      <div style="font-size:0.8rem;color:var(--text2);margin-bottom:0.5rem;">
        RNNoise uses a neural network to remove background noise during speech
        (typing, fans, background voices, music). Adds ~10ms latency.
      </div>
      <label style="display:block;cursor:pointer;font-size:0.85rem;">
        <input type="checkbox" id="settings-rnnoise-toggle" ${rnnoiseOn ? 'checked' : ''} onchange="toggleRnnoiseFromSettings(this.checked)">
        Enable noise suppression
      </label>
    </div>
  `;
}

function renderEncryptionTab(el) {
  const hasKey = !!state.myKeyPair;
  const fp = hasKey ? getKeyFingerprint() : '';
  const showSync = serverHas('key_backup');

  let buttonsHtml;
  if (hasKey) {
    buttonsHtml = `
      <div style="display:flex;gap:0.5rem;flex-wrap:wrap;margin-top:0.8rem;">
        <button class="profile-edit-btn" onclick="exportPrivateKey()">Export Key</button>
        <button class="profile-edit-btn" onclick="importPrivateKey()">Import Key</button>
        ${showSync ? '<button class="profile-edit-btn" onclick="setupKeySync()">Sync</button>' : ''}
        <button class="profile-edit-btn" style="border-color:var(--orange);color:var(--orange);" onclick="generateNewE2EKey()">Regenerate Key</button>
      </div>
    `;
  } else {
    buttonsHtml = `
      <div style="display:flex;gap:0.5rem;flex-wrap:wrap;margin-top:0.8rem;">
        <button class="profile-save-btn" onclick="generateNewE2EKey()">Generate Key</button>
        <button class="profile-edit-btn" onclick="importPrivateKey()">Import Key</button>
      </div>
    `;
  }

  el.innerHTML = `
    <div class="profile-card">
      <div class="profile-label" style="margin-bottom:0.5rem;">End-to-End Encryption</div>
      <div style="margin-bottom:0.5rem;">
        <span style="font-size:0.85rem;">Status: </span>
        ${hasKey
          ? `<span style="color:var(--green);font-size:0.85rem;">Key active</span>`
          : `<span style="color:var(--red);font-size:0.85rem;">No key set</span>`
        }
      </div>
      ${hasKey ? `
        <div style="margin-bottom:0.5rem;">
          <span style="font-size:0.75rem;color:var(--text2);">Fingerprint: </span>
          <code style="font-size:0.75rem;color:var(--green);">${fp}</code>
        </div>
      ` : `
        <div style="font-size:0.8rem;color:var(--text2);margin-bottom:0.5rem;">
          Generate or import a key to participate in encrypted channels and DMs.
        </div>
      `}
      ${buttonsHtml}
    </div>
  `;
}

export function closeUserSettings() {
  state.fileManagerOpen = false;
  closeOverlay('user-settings-overlay');
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
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', 'Message actions');
  menu.style.display = 'none';
  document.body.appendChild(menu);

  function showContextMenu(msgEl, x, y) {
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
    if (!isOwn) items += `<div class="ctx-item" data-action="hide">Hide</div>`;

    menu.innerHTML = items;
    menu.style.display = 'block';

    // Position near tap/click, but keep on screen
    const menuX = Math.min(x, window.innerWidth - 160);
    const menuY = Math.min(y, window.innerHeight - menu.offsetHeight - 10);
    menu.style.left = menuX + 'px';
    menu.style.top = menuY + 'px';

    menu.onclick = (ev) => {
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
        case 'hide': window.hideMessage(msgId); break;
      }
    };
  }

  // Desktop: right-click
  messagesEl.addEventListener('contextmenu', (e) => {
    const msgEl = e.target.closest('.msg[data-msg-id]');
    if (!msgEl) return;
    e.preventDefault();
    showContextMenu(msgEl, e.clientX, e.clientY);
  });

  // Mobile: long-press (500ms)
  let longPressTimer = null;
  let longPressFired = false;

  messagesEl.addEventListener('touchstart', (e) => {
    const msgEl = e.target.closest('.msg[data-msg-id]');
    if (!msgEl) return;
    longPressFired = false;
    const touch = e.touches[0];
    const tx = touch.clientX, ty = touch.clientY;
    longPressTimer = setTimeout(() => {
      longPressFired = true;
      showContextMenu(msgEl, tx, ty);
    }, 500);
  }, { passive: true });

  messagesEl.addEventListener('touchmove', () => {
    // Cancel long press if finger moves (user is scrolling)
    if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
  }, { passive: true });

  messagesEl.addEventListener('touchend', (e) => {
    if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
    // Prevent the tap from immediately dismissing the menu or triggering links
    if (longPressFired) {
      e.preventDefault();
      longPressFired = false;
    }
  });

  messagesEl.addEventListener('touchcancel', () => {
    if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
    longPressFired = false;
  });

  // Dismiss on click/tap elsewhere or Escape
  document.addEventListener('click', (e) => {
    if (!menu.contains(e.target)) menu.style.display = 'none';
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') menu.style.display = 'none';
  });
}

// ── Channel context menu (right-click on channel/DM list) ──

export function initChannelContextMenu() {
  const menu = document.createElement('div');
  menu.id = 'channel-context-menu';
  menu.className = 'msg-context-menu';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', 'Channel actions');
  menu.style.display = 'none';
  document.body.appendChild(menu);

  function showChannelContextMenu(channelName, x, y) {
    const isDM = isDMChannel(channelName);
    let items = '';
    if (!isDM) {
      items += `<div class="ctx-item" role="menuitem" data-action="settings">Channel Settings</div>`;
    }
    if (channelName !== 'general') {
      items += `<div class="ctx-item ctx-danger" role="menuitem" data-action="leave">Leave Channel</div>`;
    }
    if (!isDM && channelName !== 'general' && state.isAdmin) {
      items += `<div class="ctx-item ctx-danger" role="menuitem" data-action="delete">Delete Channel</div>`;
    }
    if (!items) { menu.style.display = 'none'; return; }
    menu.innerHTML = items;
    menu.style.display = 'block';

    const menuX = Math.min(x, window.innerWidth - 160);
    const menuY = Math.min(y, window.innerHeight - menu.offsetHeight - 10);
    menu.style.left = menuX + 'px';
    menu.style.top = menuY + 'px';

    menu.onclick = (ev) => {
      const item = ev.target.closest('.ctx-item');
      if (!item) return;
      menu.style.display = 'none';
      const action = item.getAttribute('data-action');
      if (action === 'settings') {
        if (state.currentChannel !== channelName) switchChannel(channelName);
        openChannelSettings();
      } else if (action === 'leave') {
        if (!confirm(`Leave ${isDM ? 'DM' : '#' + channelName}?`)) return;
        send('Leave', { channel: channelName });
        if (state.currentChannel === channelName) switchChannel('general');
      } else if (action === 'delete') {
        if (!confirm(`Delete #${channelName}? This will permanently delete all messages, topics, and files in the channel.`)) return;
        send('DeleteChannel', { channel: channelName });
      }
    };
  }

  function getChannelName(el) {
    const item = el.closest('.channel-item, .dm-item');
    if (!item) return null;
    const onclick = item.getAttribute('onclick') || '';
    const match = onclick.match(/switchChannel\('([^']+)'\)/);
    return match ? match[1] : null;
  }

  // Desktop: right-click on channel/DM list items
  ['channel-list', 'dm-list'].forEach(id => {
    const listEl = document.getElementById(id);
    if (!listEl) return;
    listEl.addEventListener('contextmenu', (e) => {
      const name = getChannelName(e.target);
      if (!name) return;
      e.preventDefault();
      showChannelContextMenu(name, e.clientX, e.clientY);
    });
  });

  // Mobile: long-press on channel/DM list items
  let chLongPressTimer = null;
  let chLongPressFired = false;

  ['channel-list', 'dm-list'].forEach(id => {
    const listEl = document.getElementById(id);
    if (!listEl) return;
    listEl.addEventListener('touchstart', (e) => {
      const name = getChannelName(e.target);
      if (!name) return;
      chLongPressFired = false;
      const touch = e.touches[0];
      const tx = touch.clientX, ty = touch.clientY;
      chLongPressTimer = setTimeout(() => {
        chLongPressFired = true;
        showChannelContextMenu(name, tx, ty);
      }, 500);
    }, { passive: true });

    listEl.addEventListener('touchmove', () => {
      if (chLongPressTimer) { clearTimeout(chLongPressTimer); chLongPressTimer = null; }
    }, { passive: true });

    listEl.addEventListener('touchend', (e) => {
      if (chLongPressTimer) { clearTimeout(chLongPressTimer); chLongPressTimer = null; }
      if (chLongPressFired) { e.preventDefault(); chLongPressFired = false; }
    });

    listEl.addEventListener('touchcancel', () => {
      if (chLongPressTimer) { clearTimeout(chLongPressTimer); chLongPressTimer = null; }
      chLongPressFired = false;
    });
  });

  // Keyboard: Shift+F10 or ContextMenu key on focused channel item
  ['channel-list', 'dm-list'].forEach(id => {
    const listEl = document.getElementById(id);
    if (!listEl) return;
    listEl.addEventListener('keydown', (e) => {
      if (e.key === 'F10' && e.shiftKey || e.key === 'ContextMenu') {
        const name = getChannelName(e.target);
        if (!name) return;
        e.preventDefault();
        const rect = e.target.getBoundingClientRect();
        showChannelContextMenu(name, rect.left + 20, rect.bottom);
      }
    });
  });

  // Dismiss
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

// chat-ui.js — Message rendering, channel list, online users, DMs, typing

import state, { isDMChannel } from './state.js';
import { send } from './transport.js';
import { escapeHtml, renderRichContent, formatFileSize, isImageMime, isAudioMime, isVideoMime } from './render.js';
import { decryptMessage } from './crypto.js';
import { apiUrl } from './config.js';

export function appendMessage(msg) {
  if (msg.channel && msg.channel !== state.currentChannel) return;

  const el = document.getElementById('messages');
  const div = document.createElement('div');
  div.className = 'msg';
  div.setAttribute('data-msg-id', msg.id);
  div.setAttribute('data-author', msg.author);

  const time = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  let ttlHtml = '';
  if (msg.expires_at) {
    const exp = new Date(msg.expires_at);
    const remaining = Math.max(0, Math.round((exp - Date.now()) / 1000));
    if (remaining < 60) ttlHtml = `<span class="ttl">[${remaining}s]</span>`;
    else if (remaining < 3600) ttlHtml = `<span class="ttl">[${Math.round(remaining/60)}m]</span>`;
    else if (remaining < 86400) ttlHtml = `<span class="ttl">[${Math.round(remaining/3600)}h]</span>`;
    else ttlHtml = `<span class="ttl">[${Math.round(remaining/86400)}d]</span>`;
  }

  let editedHtml = '';
  if (msg.edited_at) {
    editedHtml = '<span class="edited">(edited)</span>';
  }

  let displayContent = msg.content;
  let encBadge = '';
  if (msg.encrypted) {
    const ch = msg.channel || state.currentChannel;
    if (state.channelKeys[ch]) {
      const decrypted = decryptMessage(msg.content, state.channelKeys[ch]);
      if (decrypted !== null) {
        displayContent = decrypted;
      } else {
        displayContent = '[Encrypted - decryption failed]';
      }
    } else {
      displayContent = '[Encrypted - key unavailable]';
    }
    encBadge = '<span class="ttl" style="color:var(--green);">[E2E]</span>';
  }
  div.setAttribute('data-content', msg.encrypted ? displayContent : msg.content);
  div.setAttribute('data-encrypted', msg.encrypted ? '1' : '0');
  div.setAttribute('data-raw-content', msg.content);

  const content = renderRichContent(displayContent);

  // Build attachments HTML
  let attachHtml = '';
  if (msg.attachments && msg.attachments.length > 0) {
    attachHtml = '<div class="attachments">';
    for (const att of msg.attachments) {
      const url = escapeHtml(apiUrl(att.url));
      if (isImageMime(att.mime_type)) {
        attachHtml += `<a href="${url}" target="_blank"><img class="attachment-img" src="${url}" alt="${escapeHtml(att.filename)}" loading="lazy"></a>`;
      } else if (isAudioMime(att.mime_type)) {
        attachHtml += `<div class="attachment-audio"><div class="file-name">${escapeHtml(att.filename)} <span class="file-size">(${formatFileSize(att.size)})</span></div><audio controls preload="metadata" src="${url}"></audio></div>`;
      } else if (isVideoMime(att.mime_type)) {
        attachHtml += `<video controls preload="metadata" src="${url}" style="max-width:400px;max-height:300px;border-radius:4px;margin-top:0.3rem;"></video>`;
      } else {
        attachHtml += `<div class="attachment"><a href="${url}" download="${escapeHtml(att.filename)}">${escapeHtml(att.filename)}</a> <span class="file-size">${formatFileSize(att.size)}</span></div>`;
      }
    }
    attachHtml += '</div>';
  }

  // Action buttons
  let actionsHtml = '';
  const isOwn = msg.author === state.currentUser;
  if (isOwn || state.isAdmin) {
    actionsHtml = '<div class="msg-actions">';
    if (isOwn) actionsHtml += `<button onclick="startEditMessage('${msg.id}')">edit</button>`;
    actionsHtml += `<button class="del-btn" onclick="deleteMessage('${msg.id}')">del</button>`;
    actionsHtml += '</div>';
  }

  div.innerHTML = `${actionsHtml}
    <div class="meta">
      <span class="author">${escapeHtml(msg.author)}</span>
      <span class="time">${time}</span>${ttlHtml}${encBadge}${editedHtml}
    </div>
    <div class="body">${content}</div>${attachHtml}`;
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
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
    const lock = ch.encrypted ? '&#x1F512; ' : '#';
    const unread = state.unreadCounts[ch.name] || 0;
    const unreadBadge = unread > 0 ? `<span class="unread-badge">${unread > 99 ? '99+' : unread}</span>` : '';
    const boldClass = unread > 0 ? ' has-unread' : '';
    return `<div class="channel-item${boldClass} ${ch.name === state.currentChannel ? 'active' : ''}"
         onclick="switchChannel('${ch.name}')">
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
    return `<div class="dm-item${boldClass} ${ch === state.currentChannel ? 'active' : ''}" onclick="switchChannel('${escapeHtml(ch)}')">
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
  }, 3000);
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
  // Import switchView dynamically to avoid circular deps
  import('./topics.js').then(m => m.switchView('chat'));
  // Auto-join voice channels on the text side so we can send/receive messages
  if (isVoice) {
    send('Join', { channel: name });
  }
  send('History', { channel: name, limit: 100 });
  if (state.encryptedChannels.has(name) && !state.channelKeys[name] && state.e2eReady) {
    send('RequestChannelKey', { channel: name });
  }
}

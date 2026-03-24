// messages.js — Server message dispatcher

import state, { isDMChannel, emit, on as onEvent, serverHas } from './state.js';
import { send } from './transport.js';
import { initE2E, updateKeyUI, tryDecrypt, decryptChannelKey, encryptChannelKeyForUser, generateChannelKey, showKeyApproval, renderKeyRequests, checkPinnedKey, pinPublicKey, getPinnedKey, fingerprintFromBase64, showRestorePrompt } from './crypto.js';
import { appendMessage, appendSystem, renderChannels, renderVoiceChannelList, renderOnlineUsers, renderDMList, showTyping, switchChannel, renderChannelMemberPanel, updateRequestKeyButton, updateReactionInDOM, updatePinInDOM, renderPinnedPanel, renderProfileModal, avatarHtml, refreshAvatarsInDOM, refreshAllMessageActions, initUserPFP, showE2EKeyPrompt, updateGhostButton } from './chat-ui.js';
import { renderRichContent, escapeHtml } from './render.js';
import { renderVoiceMembers, createPeerConnection, handleVoiceSignal, cleanupVoice } from './voice.js';
import { removeAllTilesForUser } from './chat-ui.js';
import { switchView, renderTopicList, renderThread, appendTopicReply } from './topics.js';
import { getHiddenMessages } from './input.js';
import { renderAdminSettings, renderAdminInvites, renderAdminRoles, onInviteCreated, onUserRolesResponse } from './admin.js';
import { handleMyFileList, handleFilePinned, handleFileDeleted } from './files.js';
import { handleSearchResults, handleSearchHistory } from './search.js';
import { startTtlTicker, stopTtlTicker } from './ttl.js';
import { routeWidgetBroadcast, routeWidgetServerResponse, clearUserPresence } from './widgets/widget-api.js';
import { showNotification, renderNotificationSettings } from './notifications.js';
import { isTauri, CLIENT_PROTOCOL_VERSION } from './config.js';
import { scopedRemove } from './storage.js';

function updateSidebarTitle() {
  const sidebarTitle = document.querySelector('.sidebar-header h2');
  if (sidebarTitle && state.serverName) {
    sidebarTitle.textContent = state.serverName;
  } else if (sidebarTitle) {
    sidebarTitle.innerHTML = '&#x2381; Gathering';
  }
}

function refreshOnlineUsersSidebar() {
  if (state.onlineUsers.length > 0) {
    renderOnlineUsers(state.onlineUsers);
  }
}

export function handleServerMsg(msg) {
  switch (msg.type) {
    case 'AuthResult':
      // Store protocol negotiation info
      state.serverProtocolVersion = msg.protocol_version || null;
      state.serverCapabilities = msg.capabilities || [];

      if (msg.ok) {
        state.currentUser = msg.username;
        state.userRoles = msg.roles || [];
        state.isAdmin = state.userRoles.includes('admin');
        if (msg.ice_servers) {
          state.iceServers = msg.ice_servers;
        }
        document.getElementById('auth-screen').style.display = 'none';
        document.getElementById('chat-screen').style.display = 'flex';
        initUserPFP();
        // Show server name in sidebar header if set
        updateSidebarTitle();
        // If serverName isn't loaded yet (race with /api/server-info), fetch it now
        if (!state.serverName && window._checkServerInfo) {
          window._checkServerInfo().then(() => updateSidebarTitle());
        }
        initE2E().then(() => updateKeyUI());
        startTtlTicker();
        send('GetPreferences', {});
        // Rebuild hover action buttons now that currentUser/isAdmin are set
        refreshAllMessageActions();
        // Trigger widget presence check for the default channel
        emit('channel-switched', state.currentChannel);

        // For standalone clients: hint if the server is running a newer protocol
        if (isTauri && state.serverProtocolVersion && state.serverProtocolVersion > CLIENT_PROTOCOL_VERSION) {
          appendSystem('This server supports newer features than your client. Consider updating for the best experience.');
        }
      } else {
        document.getElementById('auth-error').textContent = msg.error || 'Auth failed';
        stopTtlTicker();
        state.token = null;
        scopedRemove('token');
        document.getElementById('auth-screen').style.display = 'flex';
      }
      break;

    case 'Message':
      if (getHiddenMessages().has(msg.id)) break;
      appendMessage(msg);
      if (msg.channel && msg.channel !== state.currentChannel && msg.author !== state.currentUser) {
        state.unreadCounts[msg.channel] = (state.unreadCounts[msg.channel] || 0) + 1;
        renderChannels();
        renderDMList();
      }
      // Mention notifications
      if (msg.mentions && msg.mentions.includes(state.currentUser) && msg.author !== state.currentUser) {
        if (msg.channel !== state.currentChannel || document.hidden) {
          const mentionType = msg.content.match(/@(channel|server)\b/) ? (msg.content.match(/@channel\b/) ? 'channel' : 'server') : 'user';
          showNotification(msg, mentionType);
          // Track unread mentions for gold badge
          if (msg.channel !== state.currentChannel) {
            state.unreadMentions[msg.channel] = true;
            renderChannels();
            renderDMList();
          }
        }
      }
      break;

    case 'History':
      // Check if this is a search-triggered history fetch
      if (state._pendingSearch && handleSearchHistory(msg)) break;
      if (msg.channel === state.currentChannel) {
        const el = document.getElementById('messages');
        el.innerHTML = '';
        if (state.encryptedChannels.has(msg.channel) && !state.channelKeys[msg.channel] && msg.messages.some(m => m.encrypted)) {
          appendSystem('Waiting for an existing member to come online and share the channel key...');
        }
        const hidden = getHiddenMessages();
        msg.messages.filter(m => !hidden.has(m.id)).forEach(m => appendMessage({ ...m, channel: msg.channel }));
      }
      break;

    case 'ChannelList':
      state.channels = msg.channels;
      state.channels.forEach(ch => {
        if (ch.encrypted) state.encryptedChannels.add(ch.name);
        if (ch.created_by) state.channelCreators[ch.name] = ch.created_by;
      });
      renderChannels();
      break;

    case 'OnlineUsers':
      state.onlineUsers = msg.users;
      renderOnlineUsers(msg.users);
      break;

    case 'UserJoined':
      if (msg.channel === state.currentChannel) {
        appendSystem(`${msg.username} joined`);
      }
      break;

    case 'UserLeft':
      if (msg.channel === state.currentChannel) {
        appendSystem(`${msg.username} left`);
      }
      clearUserPresence(msg.channel, msg.username);
      state.pendingKeyRequests = state.pendingKeyRequests.filter(r => !(r.channel === msg.channel && r.user === msg.username));
      renderKeyRequests();
      break;

    case 'UserTyping':
      if (msg.channel === state.currentChannel) {
        showTyping(msg.username);
      }
      break;

    case 'System':
      appendSystem(msg.content);
      break;

    case 'Error':
      appendSystem(`Error: ${msg.message}`);
      break;

    case 'VoiceMembers':
      state.voiceMembers = msg.users;
      // Store SFU ID mappings if present
      if (msg.sfu_ids) {
        state.sfuIdMap = msg.sfu_ids;
        state.sfuIdReverse = {};
        for (const [username, id] of Object.entries(msg.sfu_ids)) {
          state.sfuIdReverse[id] = username;
        }
      }
      if (state.sfuActive) {
        // SFU mode: render via sfu-voice.js, no WebRTC PeerConnections
        import('./sfu-voice.js').then(sfu => sfu.renderVoiceMembers());
      } else {
        renderVoiceMembers();
        msg.users.forEach(user => {
          if (user !== state.currentUser && !state.peerConnections[user]) {
            createPeerConnection(user, true);
          }
        });
      }
      break;

    case 'VoiceUserJoined':
      if (!state.voiceMembers.includes(msg.username)) state.voiceMembers.push(msg.username);
      if (state.sfuActive) {
        import('./sfu-voice.js').then(sfu => sfu.renderVoiceMembers());
      } else {
        renderVoiceMembers();
        // If we have video/screen tracks, proactively create a PC as initiator
        // so our offer includes video m= lines from the start.  The new user
        // will also initiate from VoiceMembers — glare is handled by polite/impolite.
        if (state.inVoiceChannel && (state.cameraOn || state.screenShareOn) && !state.peerConnections[msg.username]) {
          createPeerConnection(msg.username, true);
        }
      }
      break;

    case 'VoiceUserLeft':
      state.voiceMembers = state.voiceMembers.filter(u => u !== msg.username);
      if (state.sfuActive) {
        import('./sfu-voice.js').then(sfu => {
          sfu.removeSender(msg.username);
          sfu.renderVoiceMembers();
        });
      } else {
        renderVoiceMembers();
        if (state.peerConnections[msg.username]) {
          state.peerConnections[msg.username].close();
          delete state.peerConnections[msg.username];
        }
        if (state.remoteAnalysers[msg.username]) {
          clearInterval(state.remoteAnalysers[msg.username].interval);
          delete state.remoteAnalysers[msg.username];
        }
        const audioEl = document.getElementById('audio-' + msg.username);
        if (audioEl) audioEl.remove();
        removeAllTilesForUser(msg.username);
        delete state.trackMetadata[msg.username];
        delete state.peerVideoStates[msg.username];
      }
      break;

    case 'VoiceChannelOccupancy':
      state.voiceChannelOccupancy[msg.channel] = msg.users;
      renderVoiceChannelList();
      break;

    case 'VoiceSignal':
      handleVoiceSignal(msg.from_user, msg.signal_data);
      break;

    case 'UserVideoState':
      state.peerVideoStates[msg.username] = { video_on: msg.video_on, screen_share_on: msg.screen_share_on };
      if (state.sfuActive) {
        import('./sfu-voice.js').then(sfu => sfu.renderVoiceMembers());
      } else {
        renderVoiceMembers();
      }
      break;

    case 'VideoPaused':
      if (state.sfuActive) {
        import('./sfu-voice.js').then(sfu => sfu.handleVideoPaused(msg.reason));
      }
      break;

    case 'VideoResumed':
      if (state.sfuActive) {
        import('./sfu-voice.js').then(sfu => sfu.handleVideoResumed());
      }
      break;

    case 'TopicList':
      if (state._radioTopicHandler) state._radioTopicHandler(msg);
      if (msg.channel === state.currentChannel) {
        state.topicsList = msg.topics;
        renderTopicList(state.topicsList);
      }
      break;

    case 'TopicDetail':
      if (state._radioDetailHandler) state._radioDetailHandler(msg);
      if (msg.topic.id === state.currentTopicId) {
        renderThread(msg.topic, msg.replies);
      }
      break;

    case 'TopicCreated':
      if (msg.topic.channel === state.currentChannel) {
        state.topicsList.unshift(msg.topic);
        if (state.currentView === 'topics') renderTopicList(state.topicsList);
      }
      break;

    case 'TopicReplyAdded':
      if (msg.topic_id === state.currentTopicId && state.currentView === 'thread') {
        appendTopicReply(msg.reply);
      }
      { const t = state.topicsList.find(t => t.id === msg.topic_id);
        if (t) { t.reply_count++; t.last_activity = msg.reply.created_at; } }
      break;

    case 'TopicPinned':
      if (msg.channel === state.currentChannel) {
        const tp = state.topicsList.find(t => t.id === msg.topic_id);
        if (tp) tp.pinned = msg.pinned;
        state.topicsList.sort((a, b) => (b.pinned - a.pinned) || (new Date(b.last_activity) - new Date(a.last_activity)));
        if (state.currentView === 'topics') renderTopicList(state.topicsList);
        if (state.currentTopicId === msg.topic_id) {
          state.currentTopicPinned = msg.pinned;
          document.getElementById('thread-pin-btn').textContent = msg.pinned ? 'Unpin' : 'Pin';
        }
      }
      break;

    // ── Edit/Delete broadcasts ──
    case 'MessageEdited': {
      const msgEl = document.querySelector(`.msg[data-msg-id="${msg.id}"]`);
      if (msgEl) {
        let editedContent = msg.content;
        const wasEncrypted = msgEl.getAttribute('data-encrypted') === '1';
        if (wasEncrypted) {
          editedContent = tryDecrypt(msg.content, msg.channel);
        }
        const bodyEl = msgEl.querySelector('.body');
        if (bodyEl) bodyEl.innerHTML = renderRichContent(editedContent);
        msgEl.setAttribute('data-content', editedContent);
        msgEl.setAttribute('data-raw-content', msg.content);
        let editedSpan = msgEl.querySelector('.edited');
        if (!editedSpan) {
          editedSpan = document.createElement('span');
          editedSpan.className = 'edited';
          msgEl.querySelector('.meta').appendChild(editedSpan);
        }
        editedSpan.textContent = '(edited)';
      }
      break;
    }

    case 'MessageDeleted': {
      const delEl = document.querySelector(`.msg[data-msg-id="${msg.id}"]`);
      if (delEl) delEl.remove();
      break;
    }

    case 'ReactionUpdated':
      if (msg.channel === state.currentChannel) {
        updateReactionInDOM(msg);
      }
      break;

    case 'MessagePinned':
      if (msg.channel === state.currentChannel) {
        updatePinInDOM(msg);
        appendSystem(`${msg.pinned_by} ${msg.pinned ? 'pinned' : 'unpinned'} a message`);
        // Refresh pinned messages to update the banner
        send('GetPinnedMessages', { channel: msg.channel });
      }
      break;

    case 'PinnedMessages':
      renderPinnedPanel(msg);
      break;

    case 'TopicEdited':
      if (msg.channel === state.currentChannel) {
        const t = state.topicsList.find(t => t.id === msg.topic_id);
        if (t) {
          if (msg.title) {
            t.title = msg.title;
            if (msg.encrypted) t.encrypted = true;
          }
          if (state.currentView === 'topics') renderTopicList(state.topicsList);
        }
        if (state.currentTopicId === msg.topic_id && state.currentView === 'thread') {
          send('GetTopic', { topic_id: msg.topic_id });
        }
      }
      break;

    case 'TopicDeleted':
      if (msg.channel === state.currentChannel) {
        state.topicsList = state.topicsList.filter(t => t.id !== msg.topic_id);
        if (state.currentView === 'topics') renderTopicList(state.topicsList);
        if (state.currentTopicId === msg.topic_id) {
          state.currentTopicId = null;
          switchView('topics');
        }
      }
      break;

    case 'TopicReplyEdited':
      if (msg.topic_id === state.currentTopicId && state.currentView === 'thread') {
        const replyEl = document.querySelector(`.msg[data-reply-id="${msg.reply_id}"]`);
        if (replyEl) {
          let editedContent = msg.content;
          if (msg.encrypted) {
            editedContent = tryDecrypt(msg.content, state.currentChannel);
          }
          const bodyEl = replyEl.querySelector('.body');
          if (bodyEl) bodyEl.innerHTML = renderRichContent(editedContent);
          replyEl.setAttribute('data-content', editedContent);
          replyEl.setAttribute('data-raw-content', msg.content);
          let editedSpan = replyEl.querySelector('.edited');
          if (!editedSpan) {
            editedSpan = document.createElement('span');
            editedSpan.className = 'edited';
            replyEl.querySelector('.meta').appendChild(editedSpan);
          }
          editedSpan.textContent = '(edited)';
        }
      }
      break;

    case 'TopicReplyDeleted':
      if (msg.topic_id === state.currentTopicId && state.currentView === 'thread') {
        const delReplyEl = document.querySelector(`.msg[data-reply-id="${msg.reply_id}"]`);
        if (delReplyEl) delReplyEl.remove();
      }
      break;

    case 'ChannelDeleted':
      state.channels = state.channels.filter(c => c.name !== msg.channel);
      renderChannels();
      if (state.currentChannel === msg.channel) {
        switchChannel('general');
      }
      break;

    // ── E2E Encryption ──
    case 'PublicKeyStored':
      break;

    case 'PublicKeys':
      for (const [user, pk] of Object.entries(msg.keys)) {
        const status = checkPinnedKey(user, pk);
        if (status === 'mismatch') {
          emit('system-message',
            `WARNING: Public key for ${user} has changed since last seen! ` +
            `Old fingerprint: ${fingerprintFromBase64(getPinnedKey(user))} ` +
            `New fingerprint: ${fingerprintFromBase64(pk)}. ` +
            `This could indicate a compromised account or server. ` +
            `The old key is still trusted — verify with the user out-of-band before using the new key.`);
          // Do NOT update the cache with the mismatched key
          continue;
        }
        state.publicKeyCache[user] = pk;
      }
      break;

    case 'ChannelKeyData': {
      const symKey = decryptChannelKey(msg.encrypted_key);
      if (symKey) {
        state.channelKeys[msg.channel] = symKey;
        // Update has_key on the channel info so sidebar shows correct state
        const chInfo = state.channels.find(c => c.name === msg.channel);
        if (chInfo) chInfo.has_key = true;
        renderChannels();
        renderDMList();
        updateRequestKeyButton();
        if (msg.channel === state.currentChannel) {
          send('History', { channel: msg.channel, limit: 100 });
          if (state.currentView === 'topics') {
            send('ListTopics', { channel: msg.channel, limit: 50 });
          } else if (state.currentView === 'thread' && state.currentTopicId) {
            send('GetTopic', { topic_id: state.currentTopicId });
          }
        }
      }
      break;
    }

    case 'ChannelKeyRequest': {
      if (!state.channelKeys[msg.channel]) break;

      if (isDMChannel(msg.channel)) {
        // DM auto-share: verify the public key matches what we've pinned for this user.
        // If we have no pinned key, fetch independently and verify before sharing.
        const tofuStatus = checkPinnedKey(msg.requesting_user, msg.public_key);
        if (tofuStatus === 'mismatch') {
          emit('system-message',
            `Blocked DM key request from ${msg.requesting_user}: ` +
            `public key does not match previously known key. ` +
            `This could indicate a compromised server or impersonation. ` +
            `Key fingerprint: ${fingerprintFromBase64(msg.public_key)}`);
          break;
        }
        if (tofuStatus === 'new') {
          // First time seeing this key — verify independently via GetPublicKeys
          // before trusting the server-relayed key
          const user = msg.requesting_user;
          const channel = msg.channel;
          const relayedKey = msg.public_key;
          send('GetPublicKeys', { usernames: [user] });
          const checkInterval = setInterval(() => {
            if (state.publicKeyCache[user]) {
              clearInterval(checkInterval);
              if (state.publicKeyCache[user] !== relayedKey) {
                emit('system-message',
                  `Blocked DM key request from ${user}: ` +
                  `server-relayed key does not match fetched key. ` +
                  `This could indicate a server-side key substitution attack.`);
                return;
              }
              // Keys match — pin and share
              pinPublicKey(user, relayedKey);
              const sealed = encryptChannelKeyForUser(state.channelKeys[channel], relayedKey);
              send('ProvideChannelKey', { channel, target_user: user, encrypted_key: sealed });
            }
          }, 200);
          setTimeout(() => clearInterval(checkInterval), 5000);
          break;
        }
        // tofuStatus === 'ok' — key matches pinned, safe to auto-share
        const sealed = encryptChannelKeyForUser(state.channelKeys[msg.channel], msg.public_key);
        send('ProvideChannelKey', {
          channel: msg.channel,
          target_user: msg.requesting_user,
          encrypted_key: sealed,
        });
      } else {
        // Non-DM: independently verify the public key before showing approval
        const user = msg.requesting_user;
        const channel = msg.channel;
        const relayedKey = msg.public_key;
        send('GetPublicKeys', { usernames: [user] });
        const checkInterval = setInterval(() => {
          if (state.publicKeyCache[user]) {
            clearInterval(checkInterval);
            if (state.publicKeyCache[user] !== relayedKey) {
              emit('system-message',
                `Blocked key request from ${user} for #${channel}: ` +
                `server-relayed key does not match fetched key. ` +
                `This could indicate a server-side key substitution attack. ` +
                `Relayed: ${fingerprintFromBase64(relayedKey)} vs ` +
                `Fetched: ${fingerprintFromBase64(state.publicKeyCache[user])}`);
              return;
            }
            showKeyApproval(channel, user, relayedKey);
          }
        }, 200);
        setTimeout(() => clearInterval(checkInterval), 5000);
      }
      break;
    }

    case 'ChannelEncrypted':
      state.encryptedChannels.add(msg.channel);
      { const ch = state.channels.find(c => c.name === msg.channel);
        if (ch) ch.encrypted = true; }
      renderChannels();
      break;

    case 'KeyBackupStored':
      appendSystem('Key backup stored on server.');
      break;

    case 'KeyBackupDeleted':
      appendSystem('Key backup deleted from server.');
      break;

    case 'KeyBackupData':
      state._pendingKeyBackup = { encrypted_key: msg.encrypted_key, salt: msg.salt, nonce: msg.nonce, ops_limit: msg.ops_limit, mem_limit: msg.mem_limit };
      if (!state.myKeyPair) {
        showRestorePrompt(state._pendingKeyBackup);
      }
      break;

    case 'NoKeyBackup':
      state._pendingKeyBackup = null;
      break;

    case 'ChannelKeyRotated':
      if (state.e2eReady) {
        send('RequestChannelKey', { channel: msg.channel });
      }
      break;

    // ── Direct Messages ──
    case 'DMStarted':
      state.dmChannels[msg.channel] = msg.other_user;
      state.encryptedChannels.add(msg.channel);
      renderDMList();
      if (!state.e2eReady) {
        if (msg.initiated) {
          const prevCh = state.currentChannel;
          state._suppressE2EPrompt = true;
          switchChannel(msg.channel);
          showE2EKeyPrompt(() => switchChannel(prevCh || 'general'));
        } else {
          state.unreadCounts[msg.channel] = (state.unreadCounts[msg.channel] || 0) + 1;
          renderDMList();
        }
        break;
      }
      if (msg.initiated && state.e2eReady && !state.channelKeys[msg.channel]) {
        const chKey = generateChannelKey();
        state.channelKeys[msg.channel] = chKey;
        const sealedForSelf = encryptChannelKeyForUser(chKey, sodium.to_base64(state.myKeyPair.publicKey));
        send('CreateEncryptedChannel', { channel: msg.channel, encrypted_channel_key: sealedForSelf });
        send('GetPublicKeys', { usernames: [msg.other_user] });
        const waitForKey = setInterval(() => {
          if (state.publicKeyCache[msg.other_user]) {
            clearInterval(waitForKey);
            // Pin the other user's key on first DM (TOFU)
            pinPublicKey(msg.other_user, state.publicKeyCache[msg.other_user]);
            const sealedForOther = encryptChannelKeyForUser(chKey, state.publicKeyCache[msg.other_user]);
            send('ProvideChannelKey', { channel: msg.channel, target_user: msg.other_user, encrypted_key: sealedForOther });
          }
        }, 200);
        setTimeout(() => clearInterval(waitForKey), 5000);
      } else if (!msg.initiated && state.e2eReady && !state.channelKeys[msg.channel]) {
        const dmCh = msg.channel;
        setTimeout(() => {
          if (!state.channelKeys[dmCh]) {
            send('RequestChannelKey', { channel: dmCh });
          }
        }, 2000);
      }
      if (msg.initiated) {
        switchChannel(msg.channel);
      } else {
        state.unreadCounts[msg.channel] = (state.unreadCounts[msg.channel] || 0) + 1;
        renderDMList();
      }
      break;

    case 'DMList':
      msg.dms.forEach(dm => {
        state.dmChannels[dm.channel] = dm.other_user;
        state.encryptedChannels.add(dm.channel);
      });
      renderDMList();
      break;

    // ── Channel Access Control ──
    case 'ChannelRestricted':
      if (msg.channel === state.currentChannel) {
        appendSystem(`Channel is now ${msg.restricted ? 'restricted' : 'open'}`);
      }
      break;

    case 'ChannelAnonymousUpdated':
      state.channelAnonymous[msg.channel] = msg.anonymous;
      if (msg.channel === state.currentChannel) {
        appendSystem(`Anonymous mode ${msg.anonymous ? 'enabled' : 'disabled'} for this channel`);
        const anonBanner = document.getElementById('anon-banner');
        if (anonBanner) anonBanner.style.display = msg.anonymous ? 'block' : 'none';
        refreshAllMessageActions();
      }
      renderChannels();
      break;

    case 'ChannelGhostUpdated':
      state.channelForceGhost[msg.channel] = msg.force_ghost;
      if (msg.channel === state.currentChannel) {
        appendSystem(`Ghost mode ${msg.force_ghost ? 'forced' : 'unforced'} for this channel`);
        updateGhostButton();
      }
      break;

    case 'ChannelMaxTtlUpdated':
      if (msg.max_ttl_secs != null) {
        state.channelMaxTtl[msg.channel] = msg.max_ttl_secs;
      } else {
        delete state.channelMaxTtl[msg.channel];
      }
      if (msg.channel === state.currentChannel) {
        appendSystem(`Channel max TTL ${msg.max_ttl_secs != null ? 'set to ' + msg.max_ttl_secs + 's' : 'removed'}`);
        updateGhostButton();
      }
      break;

    case 'ChannelMemberList':
      state.channelMemberList = msg.members;
      state.channelRestricted = msg.restricted;
      renderChannelMemberPanel(msg);
      break;

    case 'ChannelMemberAdded':
      if (msg.channel === state.currentChannel) {
        appendSystem(`${msg.username} was added to the channel`);
      }
      break;

    case 'ChannelMemberRemoved':
      if (msg.channel === state.currentChannel) {
        appendSystem(`${msg.username} was removed from the channel`);
        if (msg.username === state.currentUser) {
          switchChannel('general');
        }
      }
      break;

    // ── Search ──
    case 'SearchResults':
      handleSearchResults(msg);
      break;

    // ── File Management ──
    case 'MyFileList':
      handleMyFileList(msg);
      break;
    case 'FilePinned':
      handleFilePinned(msg);
      break;
    case 'FileDeleted':
      handleFileDeleted(msg);
      break;

    // ── Admin responses ──
    case 'Settings': {
      // Update branding state for all clients
      const settings = msg.settings || {};
      if (settings.server_name !== undefined) {
        state.serverName = settings.server_name || null;
        updateSidebarTitle();
        if (window._renderServerRail) window._renderServerRail();
        if (window._updateAuthServerInfo) window._updateAuthServerInfo();
      }
      if (settings.server_icon !== undefined) {
        state.serverIcon = settings.server_icon || null;
        if (window._renderServerRail) window._renderServerRail();
      }
      // Only render admin panel if the user is an admin
      if (state.isAdmin) renderAdminSettings(msg.settings);
      break;
    }

    case 'InviteCreated':
      onInviteCreated(msg.code);
      break;

    case 'InviteList':
      renderAdminInvites(msg.invites);
      break;

    case 'RoleList':
      renderAdminRoles(msg.roles);
      break;

    case 'UserRoles':
      onUserRolesResponse(msg.username, msg.roles);
      break;

    // ── Preferences ──
    case 'Preferences':
      state.notificationPrefs = msg.prefs || {};
      if (msg.prefs && msg.prefs.ghost_ttl) {
        state.ghostTtl = parseInt(msg.prefs.ghost_ttl) || 86400;
      }
      renderNotificationSettings();
      break;

    // ── Widgets ──
    case 'WidgetBroadcast':
      routeWidgetBroadcast(msg);
      break;

    case 'WidgetStateLoaded':
    case 'WidgetStateSaved':
      routeWidgetServerResponse(msg);
      break;

    // ── Profiles ──
    case 'UserProfile':
      state.profileCache[msg.username] = msg.profile || {};
      // If the profile modal is showing this user, refresh it
      {
        const profileEl = document.getElementById('profile-content');
        if (profileEl && profileEl.getAttribute('data-profile-user') === msg.username) {
          renderProfileModal(msg.username);
        }
      }
      // Refresh user settings profile tab if open for current user
      if (msg.username === state.currentUser) {
        const settingsOverlay = document.getElementById('user-settings-overlay');
        const settingsTab = document.querySelector('#user-settings-tabs .active');
        if (settingsOverlay && settingsOverlay.classList.contains('active') &&
            settingsTab && settingsTab.textContent.toLowerCase() === 'profile') {
          // Re-import to avoid storing _currentSettingsTab externally
          import('./chat-ui.js').then(m => m.switchUserSettingsTab('profile', settingsTab));
        }
      }
      break;

    case 'UserProfiles':
      if (msg.profiles) {
        Object.assign(state.profileCache, msg.profiles);
        refreshOnlineUsersSidebar();
      }
      break;

    case 'ProfileUpdated':
      if (!state.profileCache[msg.username]) state.profileCache[msg.username] = {};
      state.profileCache[msg.username][msg.field] = msg.value;
      refreshOnlineUsersSidebar();
      // Refresh avatars in chat messages when avatar changes
      if (msg.field === 'avatar_id') {
        refreshAvatarsInDOM(msg.username);
        if (msg.username === state.currentUser) initUserPFP();
      }
      // Refresh profile modal if open for this user
      {
        const profileEl = document.getElementById('profile-content');
        if (profileEl && profileEl.getAttribute('data-profile-user') === msg.username
            && document.getElementById('profile-overlay').classList.contains('active')) {
          renderProfileModal(msg.username);
        }
      }
      break;

    case 'ServerShutdown':
      appendSystem(`Server shutting down: ${msg.reason}`);
      break;

    case 'Ping':
      // Application-level keepalive — no action needed (resets pong timer in transport.js)
      break;

    default:
      // Gracefully ignore message types this client doesn't know about.
      // This allows old clients to keep working when the server adds features.
      console.log(`Unknown server message type: ${msg.type}`);
      break;
  }
}

// ── Wire binary WS frames to SFU voice handler ──
onEvent('binary-message', (data) => {
  if (state.sfuActive) {
    import('./sfu-voice.js').then(sfu => sfu.handleBinaryFrame(data));
  }
});

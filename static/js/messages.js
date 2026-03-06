// messages.js — Server message dispatcher

import state, { isDMChannel, emit } from './state.js';
import { send } from './transport.js';
import { initE2E, updateKeyUI, tryDecrypt, decryptChannelKey, encryptChannelKeyForUser, generateChannelKey, showKeyApproval, renderKeyRequests } from './crypto.js';
import { appendMessage, appendSystem, renderChannels, renderVoiceChannelList, renderOnlineUsers, renderDMList, showTyping, switchChannel, renderChannelMemberPanel, updateRequestKeyButton } from './chat-ui.js';
import { renderRichContent, escapeHtml } from './render.js';
import { renderVoiceMembers, createPeerConnection, handleVoiceSignal, cleanupVoice } from './voice.js';
import { removeAllTilesForUser } from './chat-ui.js';
import { switchView, renderTopicList, renderThread, appendTopicReply } from './topics.js';
import { renderAdminSettings, renderAdminInvites, renderAdminRoles, onInviteCreated, onUserRolesResponse } from './admin.js';
import { handleMyFileList, handleFilePinned, handleFileDeleted } from './files.js';
import { handleSearchResults, handleSearchHistory } from './search.js';
import { routeWidgetBroadcast, routeWidgetServerResponse, clearUserPresence } from './widgets/widget-api.js';
import { showNotification, renderNotificationSettings } from './notifications.js';

export function handleServerMsg(msg) {
  switch (msg.type) {
    case 'AuthResult':
      if (msg.ok) {
        state.currentUser = msg.username;
        state.userRoles = msg.roles || [];
        state.isAdmin = state.userRoles.includes('admin');
        document.getElementById('auth-screen').style.display = 'none';
        document.getElementById('chat-screen').style.display = 'block';
        document.getElementById('display-user').textContent = state.currentUser;
        document.getElementById('admin-gear-btn').style.display = state.isAdmin ? '' : 'none';
        initE2E().then(() => updateKeyUI());
        send('GetPreferences', {});
        // Trigger widget presence check for the default channel
        emit('channel-switched', state.currentChannel);
      } else {
        document.getElementById('auth-error').textContent = msg.error || 'Auth failed';
        state.token = null;
        localStorage.removeItem('gathering_token');
        document.getElementById('auth-screen').style.display = 'flex';
      }
      break;

    case 'Message':
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
        msg.messages.forEach(m => appendMessage({ ...m, channel: msg.channel }));
      }
      break;

    case 'ChannelList':
      state.channels = msg.channels;
      state.channels.forEach(ch => { if (ch.encrypted) state.encryptedChannels.add(ch.name); });
      renderChannels();
      break;

    case 'OnlineUsers':
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
      renderVoiceMembers();
      msg.users.forEach(user => {
        if (user !== state.currentUser && !state.peerConnections[user]) {
          createPeerConnection(user, true);
        }
      });
      break;

    case 'VoiceUserJoined':
      if (!state.voiceMembers.includes(msg.username)) state.voiceMembers.push(msg.username);
      renderVoiceMembers();
      // If we have video/screen tracks, proactively create a PC as initiator
      // so our offer includes video m= lines from the start.  The new user
      // will also initiate from VoiceMembers — glare is handled by polite/impolite.
      if (state.inVoiceChannel && (state.cameraOn || state.screenShareOn) && !state.peerConnections[msg.username]) {
        createPeerConnection(msg.username, true);
      }
      break;

    case 'VoiceUserLeft':
      state.voiceMembers = state.voiceMembers.filter(u => u !== msg.username);
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
      renderVoiceMembers();
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
      Object.assign(state.publicKeyCache, msg.keys);
      break;

    case 'ChannelKeyData': {
      const symKey = decryptChannelKey(msg.encrypted_key);
      if (symKey) {
        state.channelKeys[msg.channel] = symKey;
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
      if (state.channelKeys[msg.channel]) {
        if (isDMChannel(msg.channel)) {
          const sealed = encryptChannelKeyForUser(state.channelKeys[msg.channel], msg.public_key);
          send('ProvideChannelKey', {
            channel: msg.channel,
            target_user: msg.requesting_user,
            encrypted_key: sealed,
          });
          state.publicKeyCache[msg.requesting_user] = msg.public_key;
        } else {
          showKeyApproval(msg.channel, msg.requesting_user, msg.public_key);
        }
      }
      break;
    }

    case 'ChannelEncrypted':
      state.encryptedChannels.add(msg.channel);
      { const ch = state.channels.find(c => c.name === msg.channel);
        if (ch) ch.encrypted = true; }
      renderChannels();
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
        switchChannel(msg.channel);
        appendSystem('This is an encrypted DM. Generate or import an E2E key (bottom of sidebar) to participate.');
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
      switchChannel(msg.channel);
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
    case 'Settings':
      renderAdminSettings(msg.settings);
      break;

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
  }
}

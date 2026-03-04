// messages.js — Server message dispatcher

import state, { isDMChannel } from './state.js';
import { send } from './transport.js';
import { initE2E, updateKeyUI, decryptMessage, decryptChannelKey, encryptChannelKeyForUser, generateChannelKey, showKeyApproval, triggerKeyRotation, renderKeyRequests } from './crypto.js';
import { appendMessage, appendSystem, renderChannels, renderOnlineUsers, renderDMList, showTyping, switchChannel } from './chat-ui.js';
import { renderRichContent, escapeHtml } from './render.js';
import { renderVoiceMembers, createPeerConnection, handleVoiceSignal, cleanupVoice } from './voice.js';
import { switchView, renderTopicList, renderThread, appendTopicReply } from './topics.js';
import { renderAdminSettings, renderAdminInvites, renderAdminRoles, onInviteCreated, onUserRolesResponse } from './admin.js';

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
      } else {
        document.getElementById('auth-error').textContent = msg.error || 'Auth failed';
        state.token = null;
        localStorage.removeItem('gathering_token');
        document.getElementById('auth-screen').style.display = 'flex';
      }
      break;

    case 'Message':
      appendMessage(msg);
      break;

    case 'History':
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
      state.pendingKeyRequests = state.pendingKeyRequests.filter(r => !(r.channel === msg.channel && r.user === msg.username));
      renderKeyRequests();
      if (state.encryptedChannels.has(msg.channel) && state.channelKeys[msg.channel] && state.e2eReady && state.publicKeyCache[msg.username]) {
        delete state.publicKeyCache[msg.username];
        triggerKeyRotation(msg.channel, msg.username);
      }
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
      break;

    case 'VoiceSignal':
      handleVoiceSignal(msg.from_user, msg.signal_data);
      break;

    case 'TopicList':
      if (msg.channel === state.currentChannel) {
        state.topicsList = msg.topics;
        renderTopicList(state.topicsList);
      }
      break;

    case 'TopicDetail':
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
        if (wasEncrypted && state.channelKeys[msg.channel]) {
          const dec = decryptMessage(msg.content, state.channelKeys[msg.channel]);
          if (dec !== null) editedContent = dec;
          else editedContent = '[Encrypted - decryption failed]';
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
          if (msg.encrypted && state.channelKeys[state.currentChannel]) {
            const dec = decryptMessage(msg.content, state.channelKeys[state.currentChannel]);
            editedContent = dec !== null ? dec : '[Encrypted - decryption failed]';
          } else if (msg.encrypted) {
            editedContent = '[Encrypted - key unavailable]';
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
      send('RequestChannelKey', { channel: msg.channel });
      break;

    // ── Direct Messages ──
    case 'DMStarted':
      state.dmChannels[msg.channel] = msg.other_user;
      state.encryptedChannels.add(msg.channel);
      renderDMList();
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
  }
}

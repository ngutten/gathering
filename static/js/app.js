// app.js — Entry point: imports all modules, wires events, auto-connects

import { isTauri } from './config.js';
import state, { on, snapshotState, restoreState, resetState } from './state.js';
import { connectWS, disconnectWS, getConnectionState } from './transport.js';
import { handleServerMsg } from './messages.js';
import { checkServerInfo, doLogin, doRegister, doLogout } from './auth.js';
import { appendMessage, appendSystem, renderChannels, renderOnlineUsers, renderDMList, startDM, showTyping, switchChannel, openChannelSettings, closeChannelSettings, toggleChannelRestricted, toggleChannelAnonymous, toggleChannelGhost, setChannelMaxTtl, addChannelMember, removeChannelMember, requestChannelKey, startReply, cancelReply, togglePinMessage, openPinnedPanel, closePinnedPanel, openProfile, closeProfile, openEditProfile, saveProfile, uploadAvatar, openUserSettings, closeUserSettings, saveUserSettings, initContextMenu, togglePinnedBanner, toggleUserMenu, closeUserMenu, initUserPFP, switchUserSettingsTab, initChannelContextMenu, openCreateChannel, closeCreateChannel, submitCreateChannel, initGhostButtons, updateGhostButton, getEffectiveGhostTtl } from './chat-ui.js';
import { sendMessage, handleInputKey, handleFileSelect, renderPendingFiles, removePendingFile, startEditMessage, cancelEdit, deleteMessage, joinChannel, setupDragAndDrop, toggleRecording, cancelRecording } from './input.js';
import { createVoiceChannel, joinVoice, joinVoiceChannel, leaveVoice, cleanupVoice, toggleMute, toggleDeafen, toggleCamera, toggleScreenShare, testTurnConnectivity } from './voice.js';
import { switchView, openTopic, backToTopics, createTopic, sendReply, handleReplyKey, togglePinTopic, startEditTopic, saveEditTopic, cancelEditTopic, deleteCurrentTopic, startEditReply, saveEditReply, cancelEditReply, deleteReply, handleTopicFileSelect, handleReplyFileSelect, removePendingFileFrom } from './topics.js';
import { openAdminPanel, closeAdminPanel, switchAdminTab, updateSetting, deleteChannel, createInvite, assignRoleToUser, removeRoleFromUser } from './admin.js';
import { exportPrivateKey, importPrivateKey, approveKeyRequest, denyKeyRequest, generateE2EKey, rekeyChannel, setupKeySync } from './crypto.js';
import { toggleEmojiPicker } from './emoji.js';
import { openFileManager, closeFileManager, toggleFilePin, deleteUserFile, downloadFile } from './files.js';
import { toggleSearch, closeSearch, executeSearch, scrollToMessage } from './search.js';
import { setNotifPref } from './notifications.js';
import { toggleWidgetPicker, toggleWidget, deactivateWidget, getActiveWidgets, onChannelSwitch as widgetChannelSwitch } from './widgets/widget-api.js';
import { send } from './transport.js';
// Import widgets to register them
import './widgets/dice-roller.js';
import './widgets/initiative.js';
import './widgets/radio.js';
import './widgets/whiteboard.js';
import './widgets/piano.js';
import './widgets/goban.js';
// Expose helpers for widgets
window._widgetTransport = { send };
window._getActiveWidgets = getActiveWidgets;
import { diceRoll, diceRollQuick } from './widgets/dice-roller.js';
import { initiativeAdd, initiativeRemove, initiativeNext, initiativeClear } from './widgets/initiative.js';
import { radioTogglePlay, radioNext, radioPrev, radioStop, radioBecameDJ, radioSetVolume, radioSeek, radioToggleDir, radioPlayDir, radioPlayFile, radioSwitchBrowse, radioPickTopicChannel, radioLoadTopicFiles, radioClearTopicFiles, radioPlayTopicFiles } from './widgets/radio.js';
import { pianoConnectMidi } from './widgets/piano.js';

// ── Wire event emitter ──
on('server-message', handleServerMsg);
on('system-message', appendSystem);
on('ws-closed', () => {
  if (state.inVoiceChannel) cleanupVoice();
});
on('channel-switched', widgetChannelSwitch);

// ── Connection status banner ──
on('connection-state', (s) => {
  let banner = document.getElementById('connection-banner');
  if (s === 'connected') {
    if (banner) banner.remove();
    return;
  }
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'connection-banner';
    const chatScreen = document.getElementById('chat-screen');
    if (chatScreen) chatScreen.prepend(banner);
  }
  if (s === 'connecting') {
    banner.className = 'connection-banner connecting';
    banner.textContent = 'Reconnecting...';
  } else {
    banner.className = 'connection-banner disconnected';
    banner.textContent = 'Disconnected \u2014 attempting to reconnect...';
  }
});

// ── Expose functions to window for inline onclick handlers ──
window.doLogin = doLogin;
window.doRegister = doRegister;
window.doLogout = doLogout;
window.joinChannel = joinChannel;
window.openCreateChannel = openCreateChannel;
window.closeCreateChannel = closeCreateChannel;
window.submitCreateChannel = submitCreateChannel;
window.switchChannel = switchChannel;
window.sendMessage = sendMessage;
window.handleInputKey = handleInputKey;
window.handleFileSelect = handleFileSelect;
window.removePendingFile = removePendingFile;
window.toggleRecording = toggleRecording;
window.cancelRecording = cancelRecording;
window.startEditMessage = startEditMessage;
window.cancelEdit = cancelEdit;
window.deleteMessage = deleteMessage;
window.startDM = startDM;
window.joinVoice = joinVoice;
window.joinVoiceChannel = joinVoiceChannel;
window.leaveVoice = leaveVoice;
window.toggleMute = toggleMute;
window.toggleDeafen = toggleDeafen;
window.createVoiceChannel = createVoiceChannel;
window.toggleCamera = toggleCamera;
window.toggleScreenShare = toggleScreenShare;
window.testTurnConnectivity = testTurnConnectivity;
window.switchView = switchView;
window.openTopic = openTopic;
window.backToTopics = backToTopics;
window.createTopic = createTopic;
window.sendReply = sendReply;
window.handleReplyKey = handleReplyKey;
window.togglePinTopic = togglePinTopic;
window.startEditTopic = startEditTopic;
window.saveEditTopic = saveEditTopic;
window.cancelEditTopic = cancelEditTopic;
window.deleteCurrentTopic = deleteCurrentTopic;
window.startEditReply = startEditReply;
window.saveEditReply = saveEditReply;
window.cancelEditReply = cancelEditReply;
window.deleteReply = deleteReply;
window.handleTopicFileSelect = handleTopicFileSelect;
window.handleReplyFileSelect = handleReplyFileSelect;
window.removePendingFileFrom = removePendingFileFrom;
window.openAdminPanel = openAdminPanel;
window.closeAdminPanel = closeAdminPanel;
window.switchAdminTab = switchAdminTab;
window.updateSetting = updateSetting;
window.deleteChannel = deleteChannel;
window.createInvite = createInvite;
window.assignRoleToUser = assignRoleToUser;
window.removeRoleFromUser = removeRoleFromUser;
window.exportPrivateKey = exportPrivateKey;
window.importPrivateKey = importPrivateKey;
window.approveKeyRequest = approveKeyRequest;
window.denyKeyRequest = denyKeyRequest;
window.generateNewE2EKey = function() {
  if (state.myKeyPair) {
    if (!confirm('You already have an E2E key. Generating a new one will make all previously encrypted messages unreadable unless you have a backup. Continue?')) return;
    generateE2EKey(true);
  } else {
    generateE2EKey(false);
  }
};
window.rekeyChannel = function(channel) {
  const ch = channel || state.currentChannel;
  if (!confirm('WARNING: Re-keying this channel is equivalent to deleting and recreating it. All existing encrypted messages, topics, and files will become permanently unreadable to everyone. This cannot be undone.\n\nContinue?')) return;
  rekeyChannel(ch);
};
window.setupKeySync = setupKeySync;
window.toggleEmojiPicker = toggleEmojiPicker;
window.openFileManager = openFileManager;
window.closeFileManager = closeFileManager;
window.toggleFilePin = toggleFilePin;
window.deleteUserFile = deleteUserFile;
window.downloadFile = downloadFile;
window.toggleSearch = toggleSearch;
window.closeSearch = closeSearch;
window.executeSearch = executeSearch;
window.scrollToMessage = scrollToMessage;
window.openChannelSettings = openChannelSettings;
window.closeChannelSettings = closeChannelSettings;
window.toggleChannelRestricted = toggleChannelRestricted;
window.toggleChannelAnonymous = toggleChannelAnonymous;
window.toggleChannelGhost = toggleChannelGhost;
window.setChannelMaxTtl = setChannelMaxTtl;
window.setGhostTtlFromSettings = function(val) {
  state.ghostTtl = parseInt(val) || 86400;
  try { localStorage.setItem('gathering_ghost_ttl', String(state.ghostTtl)); } catch(e) {}
  send('SetPreference', { key: 'ghost_ttl', value: String(state.ghostTtl) });
  updateGhostButton();
};
window.toggleGhostFromSettings = function(checked) {
  state.ghostMode = !!checked;
  try { localStorage.setItem('gathering_ghost_mode', state.ghostMode ? '1' : '0'); } catch(e) {}
  updateGhostButton();
};
window.addChannelMember = addChannelMember;
window.removeChannelMember = removeChannelMember;
window.requestChannelKey = requestChannelKey;
window.startReply = startReply;
window.cancelReply = cancelReply;
window.togglePinMessage = togglePinMessage;
window.openPinnedPanel = openPinnedPanel;
window.closePinnedPanel = closePinnedPanel;
window.togglePinnedBanner = togglePinnedBanner;
window.setNotifPref = setNotifPref;
window.toggleSidebar = function() {
  document.querySelector('.sidebar').classList.toggle('open');
  document.getElementById('sidebar-backdrop').classList.toggle('open');
};
function closeSidebar() {
  document.querySelector('.sidebar').classList.remove('open');
  document.getElementById('sidebar-backdrop').classList.remove('open');
}
// Auto-close sidebar on mobile when switching channels
on('channel-switched', closeSidebar);
// Auto-close sidebar when any button inside it is clicked (except PFP menu area)
document.querySelector('.sidebar').addEventListener('click', (e) => {
  if (e.target.closest('.user-pfp-menu-wrap')) return;
  if (e.target.closest('button')) closeSidebar();
});
window.toggleUserMenu = toggleUserMenu;
window.closeUserMenu = closeUserMenu;
window.switchUserSettingsTab = switchUserSettingsTab;
window.openProfile = openProfile;
window.closeProfile = closeProfile;
window.openEditProfile = openEditProfile;
window.saveProfile = saveProfile;
window.uploadAvatar = uploadAvatar;
window.openUserSettings = openUserSettings;
window.closeUserSettings = closeUserSettings;
window.saveUserSettings = saveUserSettings;
window.toggleWidgetPicker = toggleWidgetPicker;
window.toggleWidget = (widgetId) => toggleWidget(state.currentChannel, widgetId);
window.deactivateCurrentWidget = (widgetId) => deactivateWidget(state.currentChannel, widgetId);
window.diceRoll = diceRoll;
window.diceRollQuick = diceRollQuick;
window.initiativeAdd = initiativeAdd;
window.initiativeRemove = initiativeRemove;
window.initiativeNext = initiativeNext;
window.initiativeClear = initiativeClear;
window.radioTogglePlay = radioTogglePlay;
window.radioNext = radioNext;
window.radioPrev = radioPrev;
window.radioStop = radioStop;
window.radioBecameDJ = radioBecameDJ;
window.radioSetVolume = radioSetVolume;
window.radioSeek = radioSeek;
window.radioToggleDir = radioToggleDir;
window.radioPlayDir = radioPlayDir;
window.radioPlayFile = radioPlayFile;
window.radioSwitchBrowse = radioSwitchBrowse;
window.radioPickTopicChannel = radioPickTopicChannel;
window.radioLoadTopicFiles = radioLoadTopicFiles;
window.radioClearTopicFiles = radioClearTopicFiles;
window.radioPlayTopicFiles = radioPlayTopicFiles;
window.pianoConnectMidi = pianoConnectMidi;

// ── Mobile back button: navigate channel history, confirm before leaving ──
// Set initial history state so the first back press triggers popstate
try { history.replaceState({ channel: state.currentChannel, view: 'chat' }, '', ''); } catch(e) {}

window.addEventListener('popstate', (e) => {
  if (state.channelHistory.length > 0) {
    const entry = state.channelHistory.pop();
    state._skipHistoryPush = true;
    if (entry.type === 'view') {
      // Restore view within the same channel
      if (entry.view === 'thread' && entry.topicId) {
        import('./topics.js').then(m => { state._skipHistoryPush = true; m.openTopic(entry.topicId); });
      } else if (entry.view === 'topics') {
        import('./topics.js').then(m => { state._skipHistoryPush = true; m.switchView('topics'); });
      } else {
        import('./topics.js').then(m => { state._skipHistoryPush = true; m.switchView('chat'); });
      }
    } else {
      // Channel switch — restore channel and its view
      switchChannel(entry.channel);
      if (entry.view && entry.view !== 'chat') {
        import('./topics.js').then(m => {
          state._skipHistoryPush = true;
          if (entry.view === 'thread' && entry.topicId) {
            m.openTopic(entry.topicId);
          } else {
            m.switchView(entry.view);
          }
        });
      }
    }
  } else {
    // No more history — user is about to leave the app.
    // Push a dummy state to keep them on the page and confirm.
    history.pushState({ channel: state.currentChannel, view: state.currentView }, '', '');
    if (!confirm('Leave Gathering?')) return;
    // Actually leave: go back twice (past the dummy state we just pushed)
    history.go(-2);
  }
});

window.addEventListener('beforeunload', (e) => {
  e.preventDefault();
  // Returning a string is ignored by modern browsers but triggers the dialog
  e.returnValue = '';
});

// ── Expose state + helpers for tauri-bridge.js (classic script) ──
window._gatheringState = state;
window._snapshotState = snapshotState;
window._restoreState = restoreState;
window._resetState = resetState;
window._connectWS = connectWS;
window._disconnectWS = disconnectWS;
window._cleanupVoice = cleanupVoice;
window._checkServerInfo = checkServerInfo;
import { clearUserPresence } from './widgets/widget-api.js';
window._clearUserPresence = clearUserPresence;

// Expose connection state change callback registration for tauri-bridge
const connectionStateCallbacks = [];
state._onConnectionState = (fn) => connectionStateCallbacks.push(fn);
on('connection-state', (s) => connectionStateCallbacks.forEach(fn => fn(s)));

// Re-render server rail after auth success (to update login indicator)
on('server-message', (msg) => {
  if (msg.type === 'AuthResult' && msg.ok && window._renderServerRail) {
    window._renderServerRail();
  }
});

// ── Service Worker: code integrity monitoring ──
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(e => {
    console.warn('[sw] registration failed:', e);
  });
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data.type === 'integrity-violation') {
      showIntegrityWarning(event.data.path, event.data.expected, event.data.actual);
    }
  });
}

function showIntegrityWarning(path, expected, actual) {
  // Avoid duplicate warnings
  if (document.getElementById('integrity-warning')) return;
  const overlay = document.createElement('div');
  overlay.id = 'integrity-warning';
  overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.85);z-index:99999;display:flex;align-items:center;justify-content:center;';
  const box = document.createElement('div');
  box.style.cssText = 'background:var(--bg2,#1a1a2e);border:2px solid #e74c3c;border-radius:8px;padding:1.5rem;max-width:500px;width:90%;color:var(--text,#eee);font-family:monospace;';
  box.innerHTML = `
    <h3 style="margin:0 0 0.75rem 0;color:#e74c3c;font-size:1.1rem;">Code Integrity Warning</h3>
    <p style="font-size:0.85rem;margin:0 0 0.75rem 0;">
      The file <code style="background:var(--bg,#111);padding:0.1rem 0.3rem;border-radius:3px;">${path}</code>
      has changed since you first loaded this client.
    </p>
    <p style="font-size:0.8rem;color:#e74c3c;margin:0 0 0.75rem 0;">
      This could mean the server code was updated legitimately, or it could indicate the server has been compromised
      and is serving modified code to exfiltrate encryption keys.
    </p>
    <div style="font-size:0.7rem;color:var(--text2,#999);margin-bottom:1rem;">
      <div>Expected: <code>${expected}</code></div>
      <div>Received: <code>${actual}</code></div>
    </div>
    <p style="font-size:0.8rem;margin:0 0 1rem 0;">
      If you did not expect a server update, do <strong>not</strong> accept.
      Verify with your server admin before continuing.
    </p>
    <div style="display:flex;gap:0.5rem;justify-content:flex-end;flex-wrap:wrap;">
      <button id="integrity-accept-btn" style="padding:0.4rem 1rem;background:var(--bg3,#333);border:1px solid var(--border,#555);border-radius:4px;color:var(--text2,#999);cursor:pointer;font-family:inherit;font-size:0.8rem;">Accept Update</button>
      <button id="integrity-accept-all-btn" style="padding:0.4rem 1rem;background:var(--bg3,#333);border:1px solid var(--border,#555);border-radius:4px;color:var(--text2,#999);cursor:pointer;font-family:inherit;font-size:0.8rem;">Accept All Updates</button>
      <button id="integrity-reject-btn" style="padding:0.4rem 1rem;background:#e74c3c;color:#fff;border:none;border-radius:4px;cursor:pointer;font-family:inherit;font-size:0.8rem;">Close Page</button>
    </div>
  `;
  overlay.appendChild(box);
  document.body.appendChild(overlay);

  document.getElementById('integrity-reject-btn').addEventListener('click', () => {
    window.close();
    // If window.close() doesn't work (not opened by script), navigate away
    location.href = 'about:blank';
  });
  document.getElementById('integrity-accept-btn').addEventListener('click', () => {
    if (navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage({
        type: 'accept-update', path, hash: actual,
      });
    }
    overlay.remove();
  });
  document.getElementById('integrity-accept-all-btn').addEventListener('click', () => {
    if (navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage({ type: 'accept-update' });
    }
    overlay.remove();
  });
}

// ── Initialize ──
initContextMenu();
initChannelContextMenu();
initGhostButtons();
setupDragAndDrop();

if (isTauri) {
  // In Tauri, defer connection until storage module is ready so getServerBase()
  // returns the correct server URL instead of falling back to localhost.
  function waitForTauriStorage() {
    if (window.gatheringStorage && window.gatheringStorage.getActiveServer()) {
      checkServerInfo();
      // Re-read token from scoped storage (state.token may have been read before storage was ready)
      state.token = window.gatheringStorage.scopedGet('token');
      if (state.token) connectWS();
    } else if (window.gatheringStorage) {
      // Storage ready but no server URL — tauri-bridge will show server picker
    } else {
      setTimeout(waitForTauriStorage, 50);
    }
  }
  waitForTauriStorage();
} else {
  checkServerInfo();
  if (state.token) connectWS();
}

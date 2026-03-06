// app.js — Entry point: imports all modules, wires events, auto-connects

import state, { on } from './state.js';
import { connectWS } from './transport.js';
import { handleServerMsg } from './messages.js';
import { checkServerInfo, doLogin, doRegister, doLogout } from './auth.js';
import { appendMessage, appendSystem, renderChannels, renderOnlineUsers, renderDMList, startDM, showTyping, switchChannel, openChannelSettings, closeChannelSettings, toggleChannelRestricted, addChannelMember, removeChannelMember, requestChannelKey, startReply, cancelReply, togglePinMessage, openPinnedPanel, closePinnedPanel, openProfile, closeProfile, openEditProfile, saveProfile, uploadAvatar, openUserSettings, closeUserSettings, saveUserSettings, initContextMenu, togglePinnedBanner } from './chat-ui.js';
import { sendMessage, handleInputKey, handleFileSelect, renderPendingFiles, removePendingFile, startEditMessage, cancelEdit, deleteMessage, joinChannel } from './input.js';
import { createVoiceChannel, joinVoice, joinVoiceChannel, leaveVoice, cleanupVoice, toggleMute, toggleDeafen, toggleCamera, toggleScreenShare } from './voice.js';
import { switchView, openTopic, backToTopics, createTopic, sendReply, handleReplyKey, togglePinTopic, startEditTopic, saveEditTopic, cancelEditTopic, deleteCurrentTopic, startEditReply, saveEditReply, cancelEditReply, deleteReply, handleTopicFileSelect, handleReplyFileSelect, removePendingFileFrom } from './topics.js';
import { openAdminPanel, closeAdminPanel, switchAdminTab, updateSetting, deleteChannel, createInvite, assignRoleToUser, removeRoleFromUser } from './admin.js';
import { exportPrivateKey, importPrivateKey, approveKeyRequest, denyKeyRequest, generateE2EKey, rekeyChannel } from './crypto.js';
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
// Expose helpers for widgets
window._widgetTransport = { send };
window._getActiveWidgets = getActiveWidgets;
import { diceRoll, diceRollQuick } from './widgets/dice-roller.js';
import { initiativeAdd, initiativeRemove, initiativeNext, initiativeClear } from './widgets/initiative.js';
import { radioTogglePlay, radioNext, radioPrev, radioStop, radioBecameDJ, radioSetVolume, radioSeek, radioToggleDir, radioPlayDir, radioPlayFile, radioSwitchBrowse, radioPickTopicChannel, radioLoadTopicFiles, radioClearTopicFiles, radioPlayTopicFiles } from './widgets/radio.js';

// ── Wire event emitter ──
on('server-message', handleServerMsg);
on('system-message', appendSystem);
on('ws-closed', () => {
  if (state.inVoiceChannel) cleanupVoice();
});
on('channel-switched', widgetChannelSwitch);

// ── Expose functions to window for inline onclick handlers ──
window.doLogin = doLogin;
window.doRegister = doRegister;
window.doLogout = doLogout;
window.joinChannel = joinChannel;
window.switchChannel = switchChannel;
window.sendMessage = sendMessage;
window.handleInputKey = handleInputKey;
window.handleFileSelect = handleFileSelect;
window.removePendingFile = removePendingFile;
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

// ── Initialize ──
initContextMenu();
checkServerInfo();
if (state.token) connectWS();

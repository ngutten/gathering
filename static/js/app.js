// app.js — Entry point: imports all modules, wires events, auto-connects

import state, { on } from './state.js';
import { connectWS } from './transport.js';
import { handleServerMsg } from './messages.js';
import { checkServerInfo, doLogin, doRegister, doLogout } from './auth.js';
import { appendMessage, appendSystem, renderChannels, renderOnlineUsers, renderDMList, startDM, showTyping, switchChannel } from './chat-ui.js';
import { sendMessage, handleInputKey, handleFileSelect, renderPendingFiles, removePendingFile, startEditMessage, cancelEdit, deleteMessage, joinChannel } from './input.js';
import { createVoiceChannel, joinVoice, joinVoiceChannel, leaveVoice, cleanupVoice, toggleMute, toggleDeafen, toggleCamera, toggleScreenShare } from './voice.js';
import { switchView, openTopic, backToTopics, createTopic, sendReply, handleReplyKey, togglePinTopic, startEditTopic, saveEditTopic, cancelEditTopic, deleteCurrentTopic, startEditReply, saveEditReply, cancelEditReply, deleteReply, handleTopicFileSelect, handleReplyFileSelect, removePendingFileFrom } from './topics.js';
import { openAdminPanel, closeAdminPanel, switchAdminTab, updateSetting, deleteChannel, createInvite, assignRoleToUser, removeRoleFromUser } from './admin.js';
import { exportPrivateKey, importPrivateKey, approveKeyRequest, denyKeyRequest } from './crypto.js';
import { toggleEmojiPicker } from './emoji.js';
import { openFileManager, closeFileManager, toggleFilePin, deleteUserFile } from './files.js';
import { toggleSearch, closeSearch, executeSearch, scrollToMessage } from './search.js';

// ── Wire event emitter ──
on('server-message', handleServerMsg);
on('system-message', appendSystem);
on('ws-closed', () => {
  if (state.inVoiceChannel) cleanupVoice();
});

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
window.toggleEmojiPicker = toggleEmojiPicker;
window.openFileManager = openFileManager;
window.closeFileManager = closeFileManager;
window.toggleFilePin = toggleFilePin;
window.deleteUserFile = deleteUserFile;
window.toggleSearch = toggleSearch;
window.closeSearch = closeSearch;
window.executeSearch = executeSearch;
window.scrollToMessage = scrollToMessage;

// ── Initialize ──
checkServerInfo();
if (state.token) connectWS();

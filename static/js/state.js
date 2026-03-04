// state.js — Central state object + event emitter

const state = {
  ws: null,
  token: localStorage.getItem('gathering_token'),
  currentUser: '',
  currentChannel: 'general',
  channels: [],
  typingTimers: {},
  pendingAttachments: [],
  userRoles: [],
  isAdmin: false,
  editingMessageId: null,

  // DM state
  dmChannels: {},

  // E2E Encryption state
  e2eReady: false,
  myKeyPair: null,
  channelKeys: {},
  publicKeyCache: {},
  encryptedChannels: new Set(),
  pendingKeyRequests: [],

  // Voice state
  inVoiceChannel: false,
  voiceChannel: '',
  voiceMembers: [],
  peerConnections: {},
  localStream: null,
  isMuted: false,
  isDeafened: false,
  localAnalyser: null,
  localAnalyserInterval: null,
  remoteAnalysers: {},

  // Topics state
  currentView: 'chat',
  currentTopicId: null,
  currentTopicPinned: false,
  currentTopicAuthor: '',
  topicsList: [],
  topicPendingAttachments: [],
  replyPendingAttachments: [],

  // Admin state
  adminSettings: {},
  adminInvites: [],
  adminRoles: [],
  lastCreatedInvite: null,

  // Input state
  lastTypingSent: 0,
};

const _listeners = {};

export function on(event, fn) {
  if (!_listeners[event]) _listeners[event] = [];
  _listeners[event].push(fn);
}

export function emit(event, ...args) {
  if (_listeners[event]) {
    _listeners[event].forEach(fn => fn(...args));
  }
}

export function isDMChannel(name) {
  return name && name.startsWith('dm:');
}

export default state;

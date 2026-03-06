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
  replyTo: null,
  notificationPrefs: {},

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
  voiceChannel: '',        // The voice channel we're IN (audio connected)
  activeVoiceChannel: '',  // Same as voiceChannel, used for UI (independent of currentChannel)
  voiceChannels: [],       // List of voice channel infos from ChannelList
  voiceChannelOccupancy: {}, // { channelName: [username, ...] }
  voiceMembers: [],
  peerConnections: {},
  localStream: null,
  isMuted: false,
  isDeafened: false,
  localAnalyser: null,
  localAnalyserInterval: null,
  remoteAnalysers: {},
  userVolumes: {},        // { username: 0.0-1.0 } per-user volume
  userGainNodes: {},      // { username: GainNode } for per-user volume control

  // Video state
  cameraOn: false,
  screenShareOn: false,
  localCameraStream: null,
  localScreenStream: null,
  trackMetadata: {},    // { peerUsername: { streamId_trackId: 'camera'|'screen' } }
  peerVideoStates: {},  // { username: { video_on, screen_share_on } }

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

  // Unread tracking
  unreadCounts: {},
  lastReadTimestamps: {},
  unreadMentions: {},  // channels with unread @mentions

  // File manager state
  fileManagerOpen: false,
  currentFiles: [],
  usedBytes: 0,
  quotaBytes: 0,

  // Search state
  searchOpen: false,
  searchResults: [],

  // Channel metadata
  channelCreators: {},

  // Profile cache: { username: { avatar_id, status, about } }
  profileCache: {},

  // Online users list (kept in sync with OnlineUsers messages)
  onlineUsers: [],
};

// Load last-read timestamps from localStorage
try {
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith('gathering_last_read_')) {
      const channel = key.substring('gathering_last_read_'.length);
      state.lastReadTimestamps[channel] = localStorage.getItem(key);
    }
  }
} catch(e) {}

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

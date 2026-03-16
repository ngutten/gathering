// state.js — Central state object + event emitter

import { scopedGet, scopedEntries } from './storage.js';

const INITIAL_STATE = {
  ws: null,
  token: null,
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
  voiceChannel: '',
  activeVoiceChannel: '',
  voiceChannels: [],
  voiceChannelOccupancy: {},
  voiceMembers: [],
  peerConnections: {},
  localStream: null,
  isMuted: false,
  isDeafened: false,
  localAnalyser: null,
  localAnalyserInterval: null,
  remoteAnalysers: {},
  userVolumes: {},
  userGainNodes: {},

  // Video state
  cameraOn: false,
  screenShareOn: false,
  localCameraStream: null,
  localScreenStream: null,
  trackMetadata: {},
  peerVideoStates: {},

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
  unreadMentions: {},

  // File manager state
  fileManagerOpen: false,
  currentFiles: [],
  usedBytes: 0,
  quotaBytes: 0,

  // Navigation history (for mobile back button)
  channelHistory: [],
  _skipHistoryPush: false,

  // Search state
  searchOpen: false,
  searchResults: [],

  // Channel metadata
  channelCreators: {},
  pinnedMessages: {},

  // Profile cache
  profileCache: {},

  // Online users list
  onlineUsers: [],

  // Ghost mode
  ghostMode: false,
  ghostTtl: 86400,
  channelForceGhost: {},
  channelMaxTtl: {},
  channelAnonymous: {},

  // Protocol negotiation
  serverProtocolVersion: null,
  serverCapabilities: [],

  // ICE servers (STUN/TURN config from server)
  iceServers: [],

  // Server branding (from /api/server-info)
  serverName: null,
  serverIcon: null,
};

const state = { ...INITIAL_STATE };
// Sets need to be cloned, not spread
state.encryptedChannels = new Set();

// Load token from scoped storage
state.token = scopedGet('token');

// Load last-read timestamps from scoped storage
try {
  for (const { suffix, value } of scopedEntries('last_read_')) {
    state.lastReadTimestamps[suffix] = value;
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

/// Check if the server advertised a given capability.
/// Returns true if the server didn't send capabilities at all (pre-negotiation server = assume all).
export function serverHas(capability) {
  if (state.serverCapabilities.length === 0) return true; // old server, assume everything
  return state.serverCapabilities.includes(capability);
}

// ── Snapshot/Restore for multi-server switching ──

// Fields that should NOT be snapshot (non-serializable or transient)
const NON_SNAPSHOT_FIELDS = new Set([
  'ws', 'localStream', 'peerConnections', 'localAnalyser', 'localAnalyserInterval',
  'remoteAnalysers', 'userGainNodes', 'localCameraStream', 'localScreenStream',
]);

/** Take a snapshot of all serializable state fields */
export function snapshotState() {
  const snap = {};
  for (const key of Object.keys(state)) {
    if (NON_SNAPSHOT_FIELDS.has(key)) continue;
    const val = state[key];
    if (val instanceof Set) {
      snap[key] = { __set: [...val] };
    } else if (val && typeof val === 'object' && !Array.isArray(val)) {
      snap[key] = JSON.parse(JSON.stringify(val));
    } else if (Array.isArray(val)) {
      snap[key] = JSON.parse(JSON.stringify(val));
    } else {
      snap[key] = val;
    }
  }
  return snap;
}

/** Restore state from a snapshot */
export function restoreState(snapshot) {
  for (const key of Object.keys(snapshot)) {
    if (NON_SNAPSHOT_FIELDS.has(key)) continue;
    const val = snapshot[key];
    if (val && typeof val === 'object' && val.__set) {
      state[key] = new Set(val.__set);
    } else if (val && typeof val === 'object' && !Array.isArray(val)) {
      state[key] = JSON.parse(JSON.stringify(val));
    } else if (Array.isArray(val)) {
      state[key] = JSON.parse(JSON.stringify(val));
    } else {
      state[key] = val;
    }
  }
}

/** Reset state to initial defaults (preserves non-snapshot fields) */
export function resetState() {
  for (const key of Object.keys(INITIAL_STATE)) {
    if (NON_SNAPSHOT_FIELDS.has(key)) continue;
    const init = INITIAL_STATE[key];
    if (init instanceof Set) {
      state[key] = new Set();
    } else if (init && typeof init === 'object' && !Array.isArray(init)) {
      state[key] = {};
    } else if (Array.isArray(init)) {
      state[key] = [];
    } else {
      state[key] = init;
    }
  }
}

export default state;

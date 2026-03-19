// sfu-voice.js — SFU voice client: encode mic → binary WS, receive → decode → play
//
// The server fans out Opus-encoded audio frames over the existing WSS connection.
// No WebRTC, no ICE, no STUN, no TURN, no extra ports.

import state, { emit } from './state.js';
import { send, sendBinary } from './transport.js';
import { initOpus, opusEncode, opusDecode, closeOpus, opusSupported } from './opus-codec.js';
import { escapeHtml } from './render.js';

// ── Constants ──
const FRAME_DURATION_MS = 20;
const SAMPLE_RATE = 48000;
const FRAME_SIZE = 960; // 20ms at 48kHz
const JITTER_BUFFER_FRAMES = 3; // 60ms fixed delay
const STATS_INTERVAL_MS = 5000;

// ── Module state ──
let _audioCtx = null;
let _captureNode = null;
let _captureStream = null;
let _joinTimestamp = 0;
let _seqNum = 0;
let _statsTimer = null;
let _packetsReceived = 0;
let _packetsLost = 0;

// Per-sender playback state: { gainNode, nextPlayTime, lastSeq, analyser, analyserInterval }
const _senders = {};

function getAudioContext() {
  if (!_audioCtx || _audioCtx.state === 'closed') {
    _audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
  }
  if (_audioCtx.state === 'suspended') {
    _audioCtx.resume().catch(() => {});
  }
  return _audioCtx;
}

// ── Public API (same surface as voice.js) ──

export async function joinVoice(channel) {
  const ch = channel || state.currentChannel;

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    emit('system-message', 'Voice requires a secure connection (HTTPS). Connect via https:// or localhost.');
    return;
  }

  // Create AudioContext during user gesture
  const ctx = getAudioContext();

  try {
    await initOpus();
  } catch (err) {
    emit('system-message', 'Failed to initialize audio codec: ' + err.message);
    return;
  }

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  } catch (err) {
    emit('system-message', 'Microphone access denied: ' + err.message);
    return;
  }

  _captureStream = stream;
  state.localStream = stream;
  state.inVoiceChannel = true;
  state.voiceChannel = ch;
  state.activeVoiceChannel = ch;
  state.sfuActive = true;
  _joinTimestamp = performance.now();
  _seqNum = 0;

  // Set up AudioWorklet capture pipeline
  try {
    await ctx.audioWorklet.addModule('./js/audio-capture-processor.js');
  } catch (err) {
    // Module may already be registered
    if (!err.message.includes('already been added')) {
      console.warn('[sfu] AudioWorklet load warning:', err.message);
    }
  }

  const source = ctx.createMediaStreamSource(stream);
  _captureNode = new AudioWorkletNode(ctx, 'audio-capture-processor');

  _captureNode.port.onmessage = (e) => {
    if (state.isMuted) return;
    const pcmFrame = e.data; // Float32Array, 960 samples

    const encoded = opusEncode(pcmFrame);
    if (!encoded) return;

    // Check for silence (DTX): if all samples are near-zero, set silence flag
    let isSilent = true;
    for (let i = 0; i < pcmFrame.length; i += 48) {
      if (Math.abs(pcmFrame[i]) > 0.01) { isSilent = false; break; }
    }

    // Build client→server frame:
    // [type(1), seq(2), timestamp(4), flags(1), payload...]
    const seq = _seqNum & 0xFFFF;
    _seqNum++;
    const timestamp = ((performance.now() - _joinTimestamp) | 0) >>> 0;
    const flags = (opusSupported() ? 0x01 : 0x00) | (isSilent ? 0x02 : 0x00);

    const header = new Uint8Array(8);
    header[0] = 0x01; // type: audio
    header[1] = (seq >> 8) & 0xFF;
    header[2] = seq & 0xFF;
    header[3] = (timestamp >> 24) & 0xFF;
    header[4] = (timestamp >> 16) & 0xFF;
    header[5] = (timestamp >> 8) & 0xFF;
    header[6] = timestamp & 0xFF;
    header[7] = flags;

    const frame = new Uint8Array(8 + encoded.length);
    frame.set(header);
    frame.set(encoded, 8);
    sendBinary(frame);
  };

  source.connect(_captureNode);
  _captureNode.connect(ctx.destination); // needed to keep worklet alive (outputs silence)

  send('VoiceJoin', { channel: ch });

  // UI updates
  document.getElementById('voice-section').style.display = '';
  document.getElementById('voice-join-btn').style.display = 'none';
  document.getElementById('voice-leave-btn').style.display = '';
  document.getElementById('voice-controls').style.display = '';
  document.getElementById('voice-status').textContent = 'Connected to #' + ch + (opusSupported() ? '' : ' (uncompressed)');

  startLocalSpeakingDetection();
  startStatsReporting();

  import('./chat-ui.js').then(m => m.renderVoiceChannelList());

  if (!opusSupported()) {
    emit('system-message', 'SFU voice: using uncompressed audio (WebCodecs Opus not available). Bandwidth usage will be higher.');
  }
}

export function leaveVoice() {
  if (!state.inVoiceChannel) return;
  send('VoiceLeave', { channel: state.voiceChannel });
  cleanupVoice();
}

export function cleanupVoice() {
  // Stop capture
  if (_captureNode) {
    _captureNode.port.onmessage = null;
    _captureNode.disconnect();
    _captureNode = null;
  }
  if (_captureStream) {
    _captureStream.getTracks().forEach(t => t.stop());
    _captureStream = null;
  }
  state.localStream = null;

  // Stop all sender playback
  for (const senderId in _senders) {
    cleanupSender(senderId);
  }

  // Stop stats
  if (_statsTimer) { clearInterval(_statsTimer); _statsTimer = null; }
  _packetsReceived = 0;
  _packetsLost = 0;

  // Stop local speaking detection
  if (state.localAnalyserInterval) {
    clearInterval(state.localAnalyserInterval);
    state.localAnalyserInterval = null;
  }
  state.localAnalyser = null;

  closeOpus();

  // Close AudioContext
  if (_audioCtx && _audioCtx.state !== 'closed') {
    _audioCtx.close().catch(() => {});
    _audioCtx = null;
  }

  // Reset state
  state.inVoiceChannel = false;
  state.voiceChannel = '';
  state.activeVoiceChannel = '';
  state.voiceMembers = [];
  state.isMuted = false;
  state.isDeafened = false;
  state.sfuActive = false;
  state.sfuIdMap = {};
  state.sfuIdReverse = {};
  state.sfuQuality = {};

  // UI cleanup
  document.getElementById('voice-section').style.display = 'none';
  document.getElementById('voice-join-btn').style.display = 'none';
  document.getElementById('voice-leave-btn').style.display = 'none';
  document.getElementById('voice-controls').style.display = 'none';
  document.getElementById('voice-status').textContent = 'Not connected';
  document.getElementById('voice-members').innerHTML = '';
  document.getElementById('mute-btn').classList.remove('active');
  document.getElementById('mute-btn').textContent = 'Mute';
  document.getElementById('deafen-btn').classList.remove('active');
  document.getElementById('deafen-btn').textContent = 'Deafen';

  import('./chat-ui.js').then(m => m.renderVoiceChannelList());
}

// ── Binary frame handler (called from messages.js) ──

export function handleBinaryFrame(data) {
  if (!state.sfuActive || data.length < 10) return;

  const type = data[0];
  if (type === 0x03) {
    // Quality hint from server
    if (data.length >= 4) {
      const targetBitrate = (data[1] << 8) | data[2];
      const qualityScore = data[3];
      state.sfuQuality._server = { targetBitrate, qualityScore };
    }
    return;
  }
  if (type !== 0x01) return;

  // Forwarded audio frame:
  // [type(1), sender_id(2), seq(2), timestamp(4), flags(1), payload...]
  const senderId = (data[1] << 8) | data[2];
  const seq = (data[3] << 8) | data[4];
  const flags = data[9];
  const isSilent = (flags & 0x02) !== 0;
  const payload = data.slice(10);

  _packetsReceived++;

  // Look up username from sender_id
  const username = state.sfuIdReverse[senderId];
  if (!username) return;

  // If deafened, skip decoding
  if (state.isDeafened) return;

  // Decode and play
  if (isSilent || payload.length === 0) {
    // Silence frame — show no speaking indicator
    updateSpeakingIndicator(username, false);
    return;
  }

  const pcm = opusDecode(payload);
  if (!pcm) return;

  playAudio(senderId, username, pcm, seq);
}

// ── Playback (jitter buffer + Web Audio scheduling) ──

function ensureSender(senderId, username) {
  if (_senders[senderId]) return _senders[senderId];

  const ctx = getAudioContext();
  const gainNode = ctx.createGain();
  const vol = state.userVolumes[username] ?? 1.0;
  gainNode.gain.value = vol;
  gainNode.connect(ctx.destination);

  // Analyser for speaking detection
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 256;
  const analyserData = new Uint8Array(analyser.frequencyBinCount);

  const analyserInterval = setInterval(() => {
    analyser.getByteFrequencyData(analyserData);
    const avg = analyserData.reduce((a, b) => a + b, 0) / analyserData.length;
    updateSpeakingIndicator(username, avg > 15);
  }, 100);

  _senders[senderId] = {
    username,
    gainNode,
    analyser,
    analyserData,
    analyserInterval,
    nextPlayTime: 0,
    lastSeq: -1,
  };
  return _senders[senderId];
}

function cleanupSender(senderId) {
  const s = _senders[senderId];
  if (!s) return;
  if (s.analyserInterval) clearInterval(s.analyserInterval);
  if (s.gainNode) s.gainNode.disconnect();
  if (s.analyser) s.analyser.disconnect();
  updateSpeakingIndicator(s.username, false);
  delete _senders[senderId];
}

function playAudio(senderId, username, pcmFloat32, seq) {
  const ctx = getAudioContext();
  const sender = ensureSender(senderId, username);

  // Detect packet loss (sequence gap)
  if (sender.lastSeq >= 0) {
    const expected = (sender.lastSeq + 1) & 0xFFFF;
    if (seq !== expected) {
      const gap = ((seq - expected + 0x10000) & 0xFFFF);
      if (gap < 100) { // reasonable gap, not a sequence wrap-around discontinuity
        _packetsLost += gap;
      }
    }
  }
  sender.lastSeq = seq;

  // Schedule playback with jitter buffer delay
  const now = ctx.currentTime;
  const jitterDelay = JITTER_BUFFER_FRAMES * FRAME_DURATION_MS / 1000;

  if (sender.nextPlayTime < now) {
    // Jitter buffer underrun — reset timing
    sender.nextPlayTime = now + jitterDelay;
  }

  // Create AudioBuffer from PCM
  const buffer = ctx.createBuffer(1, pcmFloat32.length, SAMPLE_RATE);
  buffer.getChannelData(0).set(pcmFloat32);

  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(sender.analyser);
  sender.analyser.connect(sender.gainNode);
  source.start(sender.nextPlayTime);

  sender.nextPlayTime += FRAME_DURATION_MS / 1000;
}

// ── Speaking detection (local) ──

function startLocalSpeakingDetection() {
  try {
    const ctx = getAudioContext();
    const src = ctx.createMediaStreamSource(_captureStream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    src.connect(analyser);
    state.localAnalyser = analyser;
    const data = new Uint8Array(analyser.frequencyBinCount);
    state.localAnalyserInterval = setInterval(() => {
      analyser.getByteFrequencyData(data);
      const avg = data.reduce((a, b) => a + b, 0) / data.length;
      updateSpeakingIndicator(state.currentUser, avg > 15 && !state.isMuted);
    }, 100);
  } catch {}
}

function updateSpeakingIndicator(username, speaking) {
  const el = document.getElementById('voice-member-' + username);
  if (el) el.classList.toggle('speaking', speaking);
}

// ── Quality stats reporting ──

function startStatsReporting() {
  _statsTimer = setInterval(() => {
    // Build type 0x02 stats frame
    const buf = new Uint8Array(9);
    buf[0] = 0x02; // type: quality stats
    buf[1] = (_packetsReceived >> 8) & 0xFF;
    buf[2] = _packetsReceived & 0xFF;
    buf[3] = (_packetsLost >> 8) & 0xFF;
    buf[4] = _packetsLost & 0xFF;
    // jitter_ms and rtt_estimate_ms: 0 for now (future: measure)
    sendBinary(buf);

    // Update local quality display
    const totalExpected = _packetsReceived + _packetsLost;
    const lossPercent = totalExpected > 0 ? (_packetsLost / totalExpected * 100) : 0;
    state.sfuQuality._local = { packetsReceived: _packetsReceived, packetsLost: _packetsLost, lossPercent };

    // Reset counters
    _packetsReceived = 0;
    _packetsLost = 0;
  }, STATS_INTERVAL_MS);
}

// ── Voice Members Rendering (reused from voice.js pattern) ──

export function renderVoiceMembers() {
  const el = document.getElementById('voice-members');
  el.innerHTML = state.voiceMembers.map(u => {
    const isMe = u === state.currentUser;
    const vol = state.userVolumes[u] ?? 1.0;
    const volSlider = isMe ? '' :
      `<div class="voice-volume-row">` +
        `<input type="range" min="0" max="100" value="${Math.round(vol * 100)}" ` +
          `class="voice-volume-slider" data-user="${escapeHtml(u)}" ` +
          `title="Volume: ${Math.round(vol * 100)}%">` +
        `<span class="voice-volume-label">${Math.round(vol * 100)}%</span>` +
      `</div>`;

    // Quality indicator for remote users
    const qualityDot = !isMe ? '<span class="sfu-quality-dot connected"></span>' : '';

    return `<div class="voice-member connected" id="voice-member-${escapeHtml(u)}">` +
      `<div class="voice-member-info">` +
        `<span class="voice-dot"></span>` +
        `<span class="voice-name">${escapeHtml(u)}</span>${qualityDot}` +
      `</div>${volSlider}</div>`;
  }).join('');

  // Attach volume slider listeners
  el.querySelectorAll('.voice-volume-slider').forEach(slider => {
    slider.addEventListener('input', (e) => {
      const user = e.target.dataset.user;
      const vol = parseInt(e.target.value) / 100;
      setUserVolume(user, vol);
      const label = e.target.parentElement.querySelector('.voice-volume-label');
      if (label) label.textContent = Math.round(vol * 100) + '%';
      e.target.title = 'Volume: ' + Math.round(vol * 100) + '%';
    });
  });
}

export function setUserVolume(user, vol) {
  state.userVolumes[user] = vol;
  // Update gain node for this user
  for (const senderId in _senders) {
    if (_senders[senderId].username === user) {
      _senders[senderId].gainNode.gain.value = vol;
    }
  }
}

// ── Mute/Deafen (same interface as voice.js) ──

export function toggleMute() {
  state.isMuted = !state.isMuted;
  // In SFU mode, muting just stops sending frames (handled in capture callback)
  if (state.localStream) {
    state.localStream.getAudioTracks().forEach(t => t.enabled = !state.isMuted);
  }
  const btn = document.getElementById('mute-btn');
  btn.classList.toggle('active', state.isMuted);
  btn.textContent = state.isMuted ? 'Unmute' : 'Mute';
  const myEl = document.getElementById('voice-member-' + state.currentUser);
  if (myEl) myEl.classList.toggle('muted', state.isMuted);
}

export function toggleDeafen() {
  state.isDeafened = !state.isDeafened;
  const btn = document.getElementById('deafen-btn');
  btn.classList.toggle('active', state.isDeafened);
  btn.textContent = state.isDeafened ? 'Undeafen' : 'Deafen';
  if (state.isDeafened && !state.isMuted) toggleMute();
}

// ── Cleanup on VoiceUserLeft ──

export function removeSender(username) {
  for (const senderId in _senders) {
    if (_senders[senderId].username === username) {
      cleanupSender(senderId);
    }
  }
}

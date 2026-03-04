// voice.js — WebRTC peer connections, mute/deafen, speaking detection, video & screen sharing

import state, { emit } from './state.js';
import { send } from './transport.js';
import { escapeHtml } from './render.js';

const rtcConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }] };

// ── Signal queue: serialize async handleVoiceSignal calls per-user ──
const _signalQueues = {};  // { username: Promise }

function enqueueSignal(fromUser, signalData) {
  const prev = _signalQueues[fromUser] || Promise.resolve();
  _signalQueues[fromUser] = prev.then(() => _handleVoiceSignal(fromUser, signalData))
                                 .catch(err => console.error('Signal error:', err));
}

export function createVoiceChannel() {
  const input = document.getElementById('new-voice-channel');
  if (!input) return;
  let name = input.value.trim().replace(/^#/, '');
  if (!name) return;
  name = name.toLowerCase().replace(/[^a-z0-9_-]/g, '');
  if (!name) return;
  send('CreateVoiceChannel', { channel: name });
  input.value = '';
}

export function joinVoice(channel) {
  const ch = channel || state.currentChannel;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    emit('system-message', 'Voice requires a secure connection (HTTPS). Connect via https:// or localhost.');
    return;
  }
  navigator.mediaDevices.getUserMedia({ audio: true, video: false }).then(stream => {
    state.localStream = stream;
    state.inVoiceChannel = true;
    state.voiceChannel = ch;
    state.activeVoiceChannel = ch;
    send('VoiceJoin', { channel: ch });
    document.getElementById('voice-section').style.display = '';
    document.getElementById('voice-join-btn').style.display = 'none';
    document.getElementById('voice-leave-btn').style.display = '';
    document.getElementById('voice-controls').style.display = '';
    document.getElementById('voice-status').textContent = 'Connected to #' + ch;
    // Show video area
    const videoArea = document.getElementById('video-area');
    if (videoArea) videoArea.style.display = '';
    startLocalSpeakingDetection();
    // Re-render voice channel list to show active state
    import('./chat-ui.js').then(m => m.renderVoiceChannelList());
  }).catch(err => {
    emit('system-message', 'Microphone access denied: ' + err.message);
  });
}

export function joinVoiceChannel(channelName) {
  // If already in a voice channel, leave first
  if (state.inVoiceChannel) {
    send('VoiceLeave', { channel: state.voiceChannel });
    cleanupVoice();
  }
  joinVoice(channelName);
}

export function leaveVoice() {
  if (!state.inVoiceChannel) return;
  send('VoiceLeave', { channel: state.voiceChannel });
  cleanupVoice();
}

export function cleanupVoice() {
  for (const user in state.peerConnections) {
    state.peerConnections[user].close();
    if (state.remoteAnalysers[user]) {
      clearInterval(state.remoteAnalysers[user].interval);
      delete state.remoteAnalysers[user];
    }
  }
  state.peerConnections = {};
  if (state.localStream) {
    state.localStream.getTracks().forEach(t => t.stop());
    state.localStream = null;
  }
  // Stop camera stream
  if (state.localCameraStream) {
    state.localCameraStream.getTracks().forEach(t => t.stop());
    state.localCameraStream = null;
  }
  // Stop screen stream
  if (state.localScreenStream) {
    state.localScreenStream.getTracks().forEach(t => t.stop());
    state.localScreenStream = null;
  }
  state.cameraOn = false;
  state.screenShareOn = false;
  state.trackMetadata = {};
  state.peerVideoStates = {};
  if (state.localAnalyserInterval) { clearInterval(state.localAnalyserInterval); state.localAnalyserInterval = null; }
  state.localAnalyser = null;
  state.inVoiceChannel = false;
  state.voiceChannel = '';
  state.activeVoiceChannel = '';
  state.voiceMembers = [];
  state.isMuted = false;
  state.isDeafened = false;
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
  const cameraBtn = document.getElementById('camera-btn');
  if (cameraBtn) cameraBtn.classList.remove('active');
  const screenBtn = document.getElementById('screenshare-btn');
  if (screenBtn) screenBtn.classList.remove('active');
  document.querySelectorAll('audio.voice-remote').forEach(el => el.remove());
  // Remove all video tiles and hide video area
  import('./chat-ui.js').then(m => {
    m.removeAllVideoTiles();
    m.renderVoiceChannelList();
  });
  const videoArea = document.getElementById('video-area');
  if (videoArea) videoArea.style.display = 'none';
}

// ── Track Metadata ──
// Uses stream.id only as key (reliably preserved across WebRTC via MSID)

function sendTrackMetadata(targetUser, stream, type) {
  send('VoiceSignal', {
    target_user: targetUser,
    signal_data: { type: 'track-metadata', metadata: { [stream.id]: type } }
  });
}

// ── Renegotiation helper ──
// After answering an offer, we may have un-negotiated local video senders.
// Retries until the PC is stable, then sends a new offer including all tracks.

function scheduleRenegotiation(pc, targetUser) {
  const hasVideoTracks = (state.localCameraStream && state.localCameraStream.getVideoTracks().length > 0)
                      || (state.localScreenStream && state.localScreenStream.getVideoTracks().length > 0);
  if (!hasVideoTracks) return;

  let attempts = 0;
  function tryRenegotiate() {
    attempts++;
    if (attempts > 15 || pc.connectionState === 'closed' || !state.peerConnections[targetUser]) return;
    if (pc.signalingState !== 'stable' || pc._makingOffer || pc._handlingOffer) {
      setTimeout(tryRenegotiate, 300);
      return;
    }
    pc._makingOffer = true;
    pc.createOffer().then(offer => {
      if (pc.signalingState !== 'stable') return;
      return pc.setLocalDescription(offer);
    }).then(() => {
      if (pc.localDescription) {
        send('VoiceSignal', {
          target_user: targetUser,
          signal_data: { type: 'offer', sdp: pc.localDescription }
        });
      }
    }).catch(err => {
      console.error('Renegotiation error:', err);
    }).finally(() => {
      pc._makingOffer = false;
    });
  }
  setTimeout(tryRenegotiate, 300);
}

// ── Peer Connection (polite/impolite pattern) ──

export function createPeerConnection(targetUser, isInitiator) {
  // Close existing connection if any
  if (state.peerConnections[targetUser]) {
    state.peerConnections[targetUser].close();
  }

  const pc = new RTCPeerConnection(rtcConfig);
  state.peerConnections[targetUser] = pc;

  // Polite/impolite: alphabetically lower username is polite
  const polite = state.currentUser < targetUser;
  pc._polite = polite;
  pc._makingOffer = false;
  pc._handlingOffer = false;
  pc._targetUser = targetUser;

  // Set up handlers BEFORE adding tracks so onnegotiationneeded is never missed
  pc.onicecandidate = (e) => {
    if (e.candidate) {
      send('VoiceSignal', {
        target_user: targetUser,
        signal_data: { type: 'ice-candidate', candidate: e.candidate }
      });
    }
  };

  pc.onnegotiationneeded = async () => {
    if (pc._handlingOffer) return;
    try {
      pc._makingOffer = true;
      const offer = await pc.createOffer();
      if (pc.signalingState !== 'stable') return;
      await pc.setLocalDescription(offer);
      send('VoiceSignal', {
        target_user: targetUser,
        signal_data: { type: 'offer', sdp: pc.localDescription }
      });
    } catch (err) {
      console.error('onnegotiationneeded error:', err);
    } finally {
      pc._makingOffer = false;
    }
  };

  pc.ontrack = (e) => {
    const track = e.track;
    const stream = e.streams[0];

    if (track.kind === 'audio') {
      let audio = document.getElementById('audio-' + targetUser);
      if (!audio) {
        audio = document.createElement('audio');
        audio.id = 'audio-' + targetUser;
        audio.className = 'voice-remote';
        audio.autoplay = true;
        document.body.appendChild(audio);
      }
      audio.srcObject = stream;
      if (state.isDeafened) audio.muted = true;
      startRemoteSpeakingDetection(targetUser, stream);
    } else if (track.kind === 'video') {
      // Look up metadata by stream.id
      const peerMeta = state.trackMetadata[targetUser] || {};
      const tileType = peerMeta[stream.id] || 'camera';
      import('./chat-ui.js').then(m => {
        m.addVideoTile(targetUser, tileType, stream);
      });
      track.onended = () => {
        import('./chat-ui.js').then(m => m.removeVideoTile(targetUser, tileType));
      };
      track.onmute = () => {
        import('./chat-ui.js').then(m => m.removeVideoTile(targetUser, tileType));
      };
      track.onunmute = () => {
        import('./chat-ui.js').then(m => m.addVideoTile(targetUser, tileType, stream));
      };
    }
  };

  // NOW add tracks (after handlers are set so onnegotiationneeded fires correctly)
  if (state.localStream) {
    state.localStream.getTracks().forEach(track => pc.addTrack(track, state.localStream));
  }
  if (state.localCameraStream) {
    state.localCameraStream.getVideoTracks().forEach(track => {
      pc.addTrack(track, state.localCameraStream);
    });
    sendTrackMetadata(targetUser, state.localCameraStream, 'camera');
  }
  if (state.localScreenStream) {
    state.localScreenStream.getTracks().forEach(track => {
      pc.addTrack(track, state.localScreenStream);
    });
    sendTrackMetadata(targetUser, state.localScreenStream, 'screen');
  }

  // For initiator: onnegotiationneeded will fire from addTrack above.
  // Fallback in case it doesn't (some browsers).
  if (isInitiator) {
    setTimeout(async () => {
      if (pc.signalingState === 'stable' && !pc._makingOffer && !pc.remoteDescription) {
        try {
          pc._makingOffer = true;
          const offer = await pc.createOffer();
          if (pc.signalingState !== 'stable') return;
          await pc.setLocalDescription(offer);
          send('VoiceSignal', {
            target_user: targetUser,
            signal_data: { type: 'offer', sdp: pc.localDescription }
          });
        } catch (err) {
          console.error('Initial offer error:', err);
        } finally {
          pc._makingOffer = false;
        }
      }
    }, 200);
  }

  return pc;
}

// ── Voice Signal Handler (async, glare-safe, serialized per-user) ──

// Public entry point: enqueues to prevent concurrent processing
export function handleVoiceSignal(fromUser, signalData) {
  enqueueSignal(fromUser, signalData);
}

// Internal async handler — called serially per user via the queue
async function _handleVoiceSignal(fromUser, signalData) {
  if (signalData.type === 'track-metadata') {
    if (!state.trackMetadata[fromUser]) state.trackMetadata[fromUser] = {};
    Object.assign(state.trackMetadata[fromUser], signalData.metadata);
    return;
  }

  if (signalData.type === 'offer') {
    let pc = state.peerConnections[fromUser];
    const isNewPc = !pc;
    if (!pc) {
      pc = createPeerConnection(fromUser, false);
    }

    const offerCollision = pc._makingOffer || pc.signalingState !== 'stable';
    const polite = pc._polite;

    if (offerCollision && !polite) {
      // Impolite: ignore the incoming offer during collision
      return;
    }

    try {
      pc._handlingOffer = true;

      // Polite: rollback if needed (setRemoteDescription handles this in modern browsers)
      await pc.setRemoteDescription(new RTCSessionDescription(signalData.sdp));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      send('VoiceSignal', {
        target_user: fromUser,
        signal_data: { type: 'answer', sdp: pc.localDescription }
      });
    } catch (err) {
      console.error('Error handling offer from', fromUser, err);
    } finally {
      pc._handlingOffer = false;
    }

    // After answering, if we have local video tracks that weren't in the
    // incoming offer, we need to send our own offer (unified plan: only
    // the offerer can add new m= lines).
    scheduleRenegotiation(pc, fromUser);

  } else if (signalData.type === 'answer') {
    const pc = state.peerConnections[fromUser];
    if (pc) {
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(signalData.sdp));
      } catch (err) {
        console.error('Error setting answer from', fromUser, err);
      }
    }
  } else if (signalData.type === 'ice-candidate') {
    const pc = state.peerConnections[fromUser];
    if (pc) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(signalData.candidate));
      } catch (err) {
        // Ignore ICE errors during rollback
        if (!pc._polite) console.error('ICE candidate error:', err);
      }
    }
  }
}

// ── Camera Toggle ──

export async function toggleCamera() {
  if (!state.inVoiceChannel) return;

  if (state.cameraOn) {
    // Turn off camera
    if (state.localCameraStream) {
      // Remove senders before stopping tracks
      const videoTracks = state.localCameraStream.getVideoTracks();
      for (const user in state.peerConnections) {
        const pc = state.peerConnections[user];
        for (const sender of pc.getSenders()) {
          if (sender.track && videoTracks.includes(sender.track)) {
            pc.removeTrack(sender);
          }
        }
      }
      state.localCameraStream.getTracks().forEach(t => t.stop());
      state.localCameraStream = null;
    }
    state.cameraOn = false;
    const btn = document.getElementById('camera-btn');
    if (btn) btn.classList.remove('active');
    import('./chat-ui.js').then(m => m.removeVideoTile(state.currentUser, 'camera'));
    send('VideoStateChange', { channel: state.voiceChannel, video_on: false, screen_share_on: state.screenShareOn });
  } else {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      state.localCameraStream = stream;
      state.cameraOn = true;

      for (const user in state.peerConnections) {
        const pc = state.peerConnections[user];
        stream.getVideoTracks().forEach(track => pc.addTrack(track, stream));
        sendTrackMetadata(user, stream, 'camera');
      }

      const { addVideoTile } = await import('./chat-ui.js');
      addVideoTile(state.currentUser, 'camera', stream);

      const btn = document.getElementById('camera-btn');
      if (btn) btn.classList.add('active');
      send('VideoStateChange', { channel: state.voiceChannel, video_on: true, screen_share_on: state.screenShareOn });
    } catch (err) {
      emit('system-message', 'Camera access denied: ' + err.message);
    }
  }
}

// ── Screen Share Toggle ──

export async function toggleScreenShare() {
  if (!state.inVoiceChannel) return;

  if (state.screenShareOn) {
    stopScreenShare();
  } else {
    try {
      const shareAudioBtn = document.getElementById('screen-audio-btn');
      const wantAudio = shareAudioBtn && shareAudioBtn.classList.contains('active');
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: wantAudio,
      });
      state.localScreenStream = stream;
      state.screenShareOn = true;

      stream.getVideoTracks().forEach(track => {
        track.onended = () => stopScreenShare();
      });

      for (const user in state.peerConnections) {
        const pc = state.peerConnections[user];
        stream.getTracks().forEach(track => pc.addTrack(track, stream));
        sendTrackMetadata(user, stream, 'screen');
      }

      const { addVideoTile } = await import('./chat-ui.js');
      addVideoTile(state.currentUser, 'screen', stream);

      const btn = document.getElementById('screenshare-btn');
      if (btn) btn.classList.add('active');
      send('VideoStateChange', { channel: state.voiceChannel, video_on: state.cameraOn, screen_share_on: true });
    } catch (err) {
      if (err.name !== 'NotAllowedError') {
        emit('system-message', 'Screen share failed: ' + err.message);
      }
    }
  }
}

function stopScreenShare() {
  if (!state.screenShareOn) return;

  if (state.localScreenStream) {
    const allTracks = state.localScreenStream.getTracks();
    for (const user in state.peerConnections) {
      const pc = state.peerConnections[user];
      for (const sender of pc.getSenders()) {
        if (sender.track && allTracks.includes(sender.track)) {
          pc.removeTrack(sender);
        }
      }
    }
    allTracks.forEach(t => t.stop());
    state.localScreenStream = null;
  }
  state.screenShareOn = false;
  const btn = document.getElementById('screenshare-btn');
  if (btn) btn.classList.remove('active');
  import('./chat-ui.js').then(m => m.removeVideoTile(state.currentUser, 'screen'));
  send('VideoStateChange', { channel: state.voiceChannel, video_on: state.cameraOn, screen_share_on: false });
}

// ── Voice Members Rendering ──

export function renderVoiceMembers() {
  const el = document.getElementById('voice-members');
  el.innerHTML = state.voiceMembers.map(u => {
    const vs = state.peerVideoStates[u];
    let icons = '';
    if (vs) {
      if (vs.video_on) icons += '<span class="voice-icon" title="Camera on">&#x1F4F7;</span>';
      if (vs.screen_share_on) icons += '<span class="voice-icon" title="Sharing screen">&#x1F5A5;</span>';
    }
    return `<div class="voice-member" id="voice-member-${u}">` +
      `<span class="voice-dot"></span>` +
      `<span class="voice-name">${escapeHtml(u)}</span>${icons}</div>`;
  }).join('');
}

// ── Mute/Deafen ──

export function toggleMute() {
  state.isMuted = !state.isMuted;
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
  document.querySelectorAll('audio.voice-remote').forEach(el => el.muted = state.isDeafened);
  const btn = document.getElementById('deafen-btn');
  btn.classList.toggle('active', state.isDeafened);
  btn.textContent = state.isDeafened ? 'Undeafen' : 'Deafen';
  if (state.isDeafened && !state.isMuted) toggleMute();
}

// ── Speaking Detection ──

function startLocalSpeakingDetection() {
  try {
    const ctx = new AudioContext();
    const src = ctx.createMediaStreamSource(state.localStream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    src.connect(analyser);
    state.localAnalyser = analyser;
    const data = new Uint8Array(analyser.frequencyBinCount);
    state.localAnalyserInterval = setInterval(() => {
      analyser.getByteFrequencyData(data);
      const avg = data.reduce((a, b) => a + b, 0) / data.length;
      const el = document.getElementById('voice-member-' + state.currentUser);
      if (el) el.classList.toggle('speaking', avg > 15 && !state.isMuted);
    }, 100);
  } catch(e) {}
}

function startRemoteSpeakingDetection(user, stream) {
  try {
    if (state.remoteAnalysers[user]) { clearInterval(state.remoteAnalysers[user].interval); }
    const ctx = new AudioContext();
    const src = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    src.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);
    const interval = setInterval(() => {
      analyser.getByteFrequencyData(data);
      const avg = data.reduce((a, b) => a + b, 0) / data.length;
      const el = document.getElementById('voice-member-' + user);
      if (el) el.classList.toggle('speaking', avg > 15);
    }, 100);
    state.remoteAnalysers[user] = { analyser, interval };
  } catch(e) {}
}

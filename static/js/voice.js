// voice.js — WebRTC peer connections, mute/deafen, speaking detection

import state, { emit } from './state.js';
import { send } from './transport.js';
import { escapeHtml } from './render.js';

const rtcConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }] };

export function joinVoice() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    emit('system-message', 'Voice requires a secure connection (HTTPS). Connect via https:// or localhost.');
    return;
  }
  navigator.mediaDevices.getUserMedia({ audio: true, video: false }).then(stream => {
    state.localStream = stream;
    state.inVoiceChannel = true;
    state.voiceChannel = state.currentChannel;
    send('VoiceJoin', { channel: state.currentChannel });
    document.getElementById('voice-join-btn').style.display = 'none';
    document.getElementById('voice-leave-btn').style.display = '';
    document.getElementById('voice-controls').style.display = '';
    document.getElementById('voice-status').textContent = 'Connected to #' + state.currentChannel;
    startLocalSpeakingDetection();
  }).catch(err => {
    emit('system-message', 'Microphone access denied: ' + err.message);
  });
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
  if (state.localAnalyserInterval) { clearInterval(state.localAnalyserInterval); state.localAnalyserInterval = null; }
  state.localAnalyser = null;
  state.inVoiceChannel = false;
  state.voiceChannel = '';
  state.voiceMembers = [];
  state.isMuted = false;
  state.isDeafened = false;
  document.getElementById('voice-join-btn').style.display = '';
  document.getElementById('voice-leave-btn').style.display = 'none';
  document.getElementById('voice-controls').style.display = 'none';
  document.getElementById('voice-status').textContent = 'Not connected';
  document.getElementById('voice-members').innerHTML = '';
  document.getElementById('mute-btn').classList.remove('active');
  document.getElementById('mute-btn').textContent = 'Mute';
  document.getElementById('deafen-btn').classList.remove('active');
  document.getElementById('deafen-btn').textContent = 'Deafen';
  document.querySelectorAll('audio.voice-remote').forEach(el => el.remove());
}

export function createPeerConnection(targetUser, isInitiator) {
  const pc = new RTCPeerConnection(rtcConfig);
  state.peerConnections[targetUser] = pc;

  if (state.localStream) {
    state.localStream.getTracks().forEach(track => pc.addTrack(track, state.localStream));
  }

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      send('VoiceSignal', {
        target_user: targetUser,
        signal_data: { type: 'ice-candidate', candidate: e.candidate }
      });
    }
  };

  pc.ontrack = (e) => {
    let audio = document.getElementById('audio-' + targetUser);
    if (!audio) {
      audio = document.createElement('audio');
      audio.id = 'audio-' + targetUser;
      audio.className = 'voice-remote';
      audio.autoplay = true;
      document.body.appendChild(audio);
    }
    audio.srcObject = e.streams[0];
    if (state.isDeafened) audio.muted = true;
    startRemoteSpeakingDetection(targetUser, e.streams[0]);
  };

  if (isInitiator) {
    pc.createOffer().then(offer => {
      return pc.setLocalDescription(offer);
    }).then(() => {
      send('VoiceSignal', {
        target_user: targetUser,
        signal_data: { type: 'offer', sdp: pc.localDescription }
      });
    });
  }

  return pc;
}

export function handleVoiceSignal(fromUser, signalData) {
  if (signalData.type === 'offer') {
    const pc = createPeerConnection(fromUser, false);
    pc.setRemoteDescription(new RTCSessionDescription(signalData.sdp)).then(() => {
      return pc.createAnswer();
    }).then(answer => {
      return pc.setLocalDescription(answer);
    }).then(() => {
      send('VoiceSignal', {
        target_user: fromUser,
        signal_data: { type: 'answer', sdp: pc.localDescription }
      });
    });
  } else if (signalData.type === 'answer') {
    if (state.peerConnections[fromUser]) {
      state.peerConnections[fromUser].setRemoteDescription(new RTCSessionDescription(signalData.sdp));
    }
  } else if (signalData.type === 'ice-candidate') {
    if (state.peerConnections[fromUser]) {
      state.peerConnections[fromUser].addIceCandidate(new RTCIceCandidate(signalData.candidate));
    }
  }
}

export function renderVoiceMembers() {
  const el = document.getElementById('voice-members');
  el.innerHTML = state.voiceMembers.map(u =>
    `<div class="voice-member" id="voice-member-${u}">` +
    `<span class="voice-dot"></span>` +
    `<span class="voice-name">${escapeHtml(u)}</span></div>`
  ).join('');
}

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

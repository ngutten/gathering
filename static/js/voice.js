// voice.js — WebRTC peer connections, mute/deafen, speaking detection, video & screen sharing

import state, { emit } from './state.js';
import { send } from './transport.js';
import { escapeHtml } from './render.js';

// Shared AudioContext — created during user gesture (joinVoice) so it won't be
// suspended by Chrome's autoplay policy.  Reused for all audio routing & analysis.
let _voiceAudioCtx = null;

function getVoiceAudioContext() {
  if (!_voiceAudioCtx || _voiceAudioCtx.state === 'closed') {
    _voiceAudioCtx = new AudioContext();
  }
  // Resume in case it was suspended (belt-and-suspenders)
  if (_voiceAudioCtx.state === 'suspended') {
    _voiceAudioCtx.resume().catch(() => {});
  }
  return _voiceAudioCtx;
}

function getRtcConfig() {
  return { iceServers: state.iceServers || [] };
}

// ── TURN connectivity test ──
// Creates a temporary PeerConnection to gather ICE candidates and check
// whether STUN (srflx) and TURN (relay) candidates are returned.
export function testTurnConnectivity() {
  if (typeof RTCPeerConnection === 'undefined') {
    emit('system-message', 'TURN test: WebRTC is not available in this environment.');
    return;
  }
  const servers = state.iceServers;
  if (!servers || servers.length === 0) {
    emit('system-message', 'TURN test: No ICE servers configured (public_address not set on server).');
    return;
  }
  emit('system-message', 'TURN test: checking connectivity...');
  console.log('ICE servers:', JSON.stringify(servers));

  const pc = new RTCPeerConnection({ iceServers: servers, iceCandidatePoolSize: 0 });
  const candidates = { host: 0, srflx: 0, relay: 0 };
  let done = false;

  const finish = (timedOut) => {
    if (done) return;
    done = true;
    pc.close();
    const parts = [];
    if (candidates.host) parts.push(`host: ${candidates.host}`);
    if (candidates.srflx) parts.push(`STUN (srflx): ${candidates.srflx}`);
    if (candidates.relay) parts.push(`TURN (relay): ${candidates.relay}`);

    const summary = parts.length ? parts.join(', ') : 'none';
    console.log('TURN test candidates:', summary, timedOut ? '(timed out)' : '');

    if (candidates.relay > 0) {
      emit('system-message', `TURN test passed — relay candidates obtained. (${summary})`);
    } else if (candidates.srflx > 0) {
      emit('system-message', `TURN test: STUN works but no TURN relay candidates. Check TURN credentials and that UDP ports 3478 + 49152-49252 are reachable. (${summary})`);
    } else if (candidates.host > 0) {
      emit('system-message', `TURN test: only local candidates — STUN/TURN server unreachable. Check that UDP port 3478 is open on the server. (${summary})`);
    } else {
      emit('system-message', `TURN test: no candidates gathered at all. WebRTC may be blocked.`);
    }
  };

  pc.onicecandidate = (e) => {
    if (!e.candidate) {
      finish(false);
      return;
    }
    const c = e.candidate;
    console.log(`TURN test candidate: ${c.type} ${c.protocol} ${c.address}:${c.port}`);
    if (c.type === 'host') candidates.host++;
    else if (c.type === 'srflx') candidates.srflx++;
    else if (c.type === 'relay') candidates.relay++;
  };

  pc.onicegatheringstatechange = () => {
    if (pc.iceGatheringState === 'complete') finish(false);
  };

  // Create a data channel to trigger ICE gathering
  pc.createDataChannel('turn-test');
  pc.createOffer().then(offer => pc.setLocalDescription(offer)).catch(err => {
    emit('system-message', `TURN test error: ${err.message}`);
    done = true;
    pc.close();
  });

  // Timeout after 10 seconds
  setTimeout(() => finish(true), 10000);
}

// ── Signal queue: serialize async handleVoiceSignal calls per-user ──
const _signalQueues = {};  // { username: Promise }

function enqueueSignal(fromUser, signalData) {
  const prev = _signalQueues[fromUser] || Promise.resolve();
  _signalQueues[fromUser] = prev.then(() => _handleVoiceSignal(fromUser, signalData))
                                 .catch(err => console.error('Signal error:', err));
}

export function createVoiceChannel(channelName) {
  if (!channelName) return;
  let name = channelName.trim().replace(/^#/, '').toLowerCase().replace(/[^a-z0-9_-]/g, '');
  if (!name) return;
  send('CreateVoiceChannel', { channel: name });
}

export function joinVoice(channel) {
  const ch = channel || state.currentChannel;
  if (typeof RTCPeerConnection === 'undefined') {
    emit('system-message', 'Voice chat is not supported in this environment (WebRTC unavailable).');
    return;
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    emit('system-message', 'Voice requires a secure connection (HTTPS). Connect via https:// or localhost.');
    return;
  }
  // Create shared AudioContext now, during the user gesture, so Chrome won't
  // suspend it.  This context is reused for all audio routing & speaking detection.
  getVoiceAudioContext();

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
  state.userGainNodes = {};
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
  // Close shared AudioContext
  if (_voiceAudioCtx && _voiceAudioCtx.state !== 'closed') {
    _voiceAudioCtx.close().catch(() => {});
    _voiceAudioCtx = null;
  }
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
  if (typeof RTCPeerConnection === 'undefined') return null;

  // Close existing connection if any
  if (state.peerConnections[targetUser]) {
    state.peerConnections[targetUser].close();
  }

  const pc = new RTCPeerConnection(getRtcConfig());
  state.peerConnections[targetUser] = pc;

  // Polite/impolite: alphabetically lower username is polite
  const polite = state.currentUser < targetUser;
  pc._polite = polite;
  pc._makingOffer = false;
  pc._handlingOffer = false;
  pc._targetUser = targetUser;

  // Set up handlers BEFORE adding tracks so onnegotiationneeded is never missed
  // ── Connection state monitoring ──
  pc._wasConnected = false;
  pc._iceRestartAttempts = 0;

  pc.oniceconnectionstatechange = () => {
    const iceState = pc.iceConnectionState;
    console.log(`ICE connection to ${targetUser}: ${iceState}`);

    // Update voice dot: show green when connected (even before speaking)
    const memberEl = document.getElementById('voice-member-' + targetUser);
    if (memberEl) {
      memberEl.classList.toggle('connected', iceState === 'connected' || iceState === 'completed');
    }

    if (iceState === 'connected' || iceState === 'completed') {
      pc._wasConnected = true;
      pc._iceRestartAttempts = 0;
      // Log the connection type (direct/STUN/TURN) for diagnostics
      if (pc.getStats) {
        pc.getStats().then(stats => {
          stats.forEach(report => {
            if (report.type === 'candidate-pair' && report.state === 'succeeded') {
              const local = stats.get(report.localCandidateId);
              const remote = stats.get(report.remoteCandidateId);
              if (local && remote) {
                const via = local.candidateType === 'relay' ? 'TURN relay' :
                            local.candidateType === 'srflx' ? 'STUN' : 'direct';
                console.log(`Voice to ${targetUser}: connected via ${via} (${local.candidateType}/${remote.candidateType})`);
                emit('system-message', `Voice connected to ${targetUser} (via ${via})`);
              }
            }
          });
        }).catch(() => {});
      }
    } else if (iceState === 'checking') {
      emit('system-message', `Connecting to ${targetUser}...`);
    } else if (iceState === 'disconnected') {
      if (pc._wasConnected) {
        emit('system-message', `Voice connection to ${targetUser} interrupted — attempting to reconnect...`);
      } else {
        emit('system-message', `Voice connection to ${targetUser} could not be established. Check that UDP ports 3478 and 49152-49252 are forwarded/open on the server.`);
      }
    } else if (iceState === 'failed') {
      if (pc._wasConnected) {
        emit('system-message', `Voice connection to ${targetUser} lost.`);
      } else {
        emit('system-message', `Voice connection to ${targetUser} failed — no route found. Ensure the TURN server is reachable and UDP ports 3478 + 49152-49252 are open.`);
      }
      // Try one ICE restart
      if (pc._iceRestartAttempts < 1 && pc.signalingState === 'stable' && !pc._makingOffer) {
        pc._iceRestartAttempts++;
        pc._makingOffer = true;
        pc.createOffer({ iceRestart: true }).then(offer => {
          if (pc.signalingState !== 'stable') return;
          return pc.setLocalDescription(offer);
        }).then(() => {
          if (pc.localDescription) {
            send('VoiceSignal', {
              target_user: targetUser,
              signal_data: { type: 'offer', sdp: pc.localDescription }
            });
          }
        }).catch(err => console.error('ICE restart error:', err))
          .finally(() => { pc._makingOffer = false; });
      }
    }
  };

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      send('VoiceSignal', {
        target_user: targetUser,
        signal_data: { type: 'ice-candidate', candidate: e.candidate }
      });
    }
  };

  pc.onnegotiationneeded = async () => {
    if (pc._handlingOffer || pc._suppressNegotiation) return;
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

    console.log(`[voice] ontrack from ${targetUser}: kind=${track.kind}, streams=${e.streams.length}, track.enabled=${track.enabled}, track.muted=${track.muted}`);

    if (track.kind === 'audio') {
      if (!stream) {
        console.error(`[voice] No stream for audio track from ${targetUser}`);
        return;
      }
      const audioCtx = getVoiceAudioContext();
      console.log(`[voice] AudioContext state: ${audioCtx.state}`);

      // Route through GainNode for per-user volume control
      const source = audioCtx.createMediaStreamSource(stream);
      const gainNode = audioCtx.createGain();
      const vol = state.userVolumes[targetUser] ?? 1.0;
      gainNode.gain.value = vol;
      state.userGainNodes[targetUser] = gainNode;

      // Create a destination stream that includes the gain-adjusted audio
      const dest = audioCtx.createMediaStreamDestination();
      source.connect(gainNode);
      gainNode.connect(dest);

      let audio = document.getElementById('audio-' + targetUser);
      if (!audio) {
        audio = document.createElement('audio');
        audio.id = 'audio-' + targetUser;
        audio.className = 'voice-remote';
        audio.autoplay = true;
        document.body.appendChild(audio);
      }
      audio.srcObject = dest.stream;
      audio.volume = vol;
      if (state.isDeafened) audio.muted = true;
      // Explicit play() — autoplay may be blocked outside user gesture context
      audio.play().catch(err => console.warn(`[voice] audio.play() blocked for ${targetUser}:`, err));
      startRemoteSpeakingDetection(targetUser, stream);

      // Monitor track unmute (tracks often start muted until media flows)
      if (track.muted) {
        track.onunmute = () => console.log(`[voice] Audio track from ${targetUser} unmuted`);
        // Check RTP stats after a few seconds
        setTimeout(() => {
          const currentPc = state.peerConnections[targetUser];
          if (!currentPc) return;
          currentPc.getStats().then(stats => {
            stats.forEach(report => {
              if (report.type === 'inbound-rtp' && report.kind === 'audio') {
                console.log(`[voice] Audio RTP from ${targetUser}: bytes=${report.bytesReceived}, packets=${report.packetsReceived}, packetsLost=${report.packetsLost}`);
              }
            });
          });
          console.log(`[voice] PC connectionState=${currentPc.connectionState}, iceConnectionState=${currentPc.iceConnectionState}, track.muted=${track.muted}`);
        }, 3000);
      }
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
      console.log(`[voice] Ignoring offer from ${fromUser} (collision, impolite)`);
      return;
    }

    try {
      pc._handlingOffer = true;
      console.log(`[voice] Handling offer from ${fromUser} (new PC: ${isNewPc})`);

      // Polite: rollback if needed (setRemoteDescription handles this in modern browsers)
      await pc.setRemoteDescription(new RTCSessionDescription(signalData.sdp));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      send('VoiceSignal', {
        target_user: fromUser,
        signal_data: { type: 'answer', sdp: pc.localDescription }
      });
      console.log(`[voice] Sent answer to ${fromUser}`);
      // Tracks added during createPeerConnection are already negotiated in
      // this answer.  Suppress the stale onnegotiationneeded that addTrack
      // queued — it would send a pointless offer and confuse the remote peer.
      pc._suppressNegotiation = true;
      setTimeout(() => { pc._suppressNegotiation = false; }, 0);
    } catch (err) {
      console.error('Error handling offer from', fromUser, err);
      emit('system-message', `Voice signaling error with ${fromUser}: ${err.message}`);
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
      if (pc.signalingState !== 'have-local-offer') {
        // Stale answer (e.g. from a renegotiation we no longer need) — safe to ignore
        console.log(`[voice] Ignoring stale answer from ${fromUser} (state: ${pc.signalingState})`);
      } else {
        try {
          console.log(`[voice] Received answer from ${fromUser}`);
          await pc.setRemoteDescription(new RTCSessionDescription(signalData.sdp));
        } catch (err) {
          console.error('Error setting answer from', fromUser, err);
        }
      }
    } else {
      console.warn(`[voice] Received answer from ${fromUser} but no PeerConnection exists`);
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
    const isMe = u === state.currentUser;
    const vol = state.userVolumes[u] ?? 1.0;
    const volSlider = isMe ? '' :
      `<div class="voice-volume-row">` +
        `<input type="range" min="0" max="100" value="${Math.round(vol * 100)}" ` +
          `class="voice-volume-slider" data-user="${escapeHtml(u)}" ` +
          `title="Volume: ${Math.round(vol * 100)}%">` +
        `<span class="voice-volume-label">${Math.round(vol * 100)}%</span>` +
      `</div>`;
    return `<div class="voice-member" id="voice-member-${u}">` +
      `<div class="voice-member-info">` +
        `<span class="voice-dot"></span>` +
        `<span class="voice-name">${escapeHtml(u)}</span>${icons}` +
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
  // Update GainNode if exists
  const gainNode = state.userGainNodes[user];
  if (gainNode) gainNode.gain.value = vol;
  // Also update audio element volume as fallback
  const audio = document.getElementById('audio-' + user);
  if (audio) audio.volume = vol;
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
    const ctx = getVoiceAudioContext();
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
    const ctx = getVoiceAudioContext();
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

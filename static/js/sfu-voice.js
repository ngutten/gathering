// sfu-voice.js — SFU voice + video client: encode mic/camera/screen → binary WS, receive → decode → play/display
//
// The server fans out Opus-encoded audio and VP8-encoded video frames over the existing WSS connection.
// No WebRTC, no ICE, no STUN, no TURN, no extra ports.

import state, { emit } from './state.js';
import { send, sendBinary } from './transport.js';
import { initOpus, opusEncode, opusDecode, setOnEncoded, setOnDecoded, setOnDecodeError, closeOpus, opusSupported } from './opus-codec.js';
import { initVideoCodec, videoEncode, videoDecode, requestKeyframe, closeVideoCodec, videoCodecSupported } from './video-codec.js';
import { escapeHtml } from './render.js';
import { buildAudioPipeline, setRnnoiseEnabled, MIC_CONSTRAINTS } from './audio-pipeline.js';
import { scopedGet } from './storage.js';

// ── Constants ──
const FRAME_DURATION_MS = 20;
const SAMPLE_RATE = 48000;
const FRAME_SIZE = 960; // 20ms at 48kHz
// Adaptive jitter buffer bounds (in ms)
const JITTER_MIN_MS = 40;   // 2 frames — floor (safe minimum)
const JITTER_MAX_MS = 120;  // 6 frames — ceiling for bad connections
const JITTER_ALPHA = 0.15;  // EMA smoothing factor for jitter estimation (higher = faster adapt)
const STATS_INTERVAL_MS = 5000;
const VIDEO_FPS = 30;
const VIDEO_FRAME_INTERVAL = 1000 / VIDEO_FPS;

// ── Module state (audio) ──
let _audioCtx = null;
let _captureNode = null;
let _captureStream = null;
let _audioPipeline = null;
let _joinTimestamp = 0;
let _seqNum = 0;
let _statsTimer = null;
let _packetsReceived = 0;
let _packetsLost = 0;
let _silentFrameCount = 0;
const SILENCE_HOLDOVER_FRAMES = 50; // Keep sending for 1s after speech ends

// ── Module state (video) ──
let _localCameraStream = null;
let _localScreenStream = null;
let _videoCaptureTimer = null;
let _screenCaptureTimer = null;
let _videoSeqNum = 0;
let _videoPaused = false; // Server told us video is paused for bandwidth

// Per-sender playback state: { gainNode, nextPlayTime, lastSeq, analyser, analyserInterval, ... }
const _senders = {};

// Queue of pending decode contexts (senderId, username, seq) — consumed by onDecoded callback
const _pendingDecodes = [];

// Per-sender video decoders: { canvas, ctx, decoder (if WebCodecs) }
const _videoReceivers = {};

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

  // Register decode callback — fires when WebCodecs produces decoded PCM
  setOnDecoded((pcm) => {
    const ctx = _pendingDecodes.shift();
    if (!ctx) return;
    playAudio(ctx.senderId, ctx.username, pcm, ctx.seq);
  });

  // If a decode errors, discard the pending context to keep the queue in sync
  setOnDecodeError(() => {
    _pendingDecodes.shift();
  });

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: MIC_CONSTRAINTS, video: false });
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
  _silentFrameCount = 0;
  _videoSeqNum = 0;
  _videoPaused = false;

  // Build audio processing pipeline: high-pass filter + noise gate
  let pipelineOutput;
  try {
    const rnnoiseEnabled = scopedGet('rnnoise_enabled') !== 'false';
    const pipeline = await buildAudioPipeline(ctx, stream, { rnnoiseEnabled });
    _audioPipeline = pipeline;
    pipelineOutput = pipeline.outputNode;
  } catch (pipelineErr) {
    // Fallback: connect mic source directly
    console.warn('[sfu] Audio pipeline failed, using raw mic:', pipelineErr);
    pipelineOutput = ctx.createMediaStreamSource(stream);
  }

  // Set up AudioWorklet processors (capture + playback)
  // Use import.meta.url for correct resolution in Tauri (where document base URL
  // differs from the asset protocol used by AudioWorklet module fetches).
  const modules = ['audio-capture-processor.js', 'audio-playback-processor.js'];
  for (const mod of modules) {
    try {
      const url = new URL('./' + mod, import.meta.url).href;
      await ctx.audioWorklet.addModule(url);
    } catch (err) {
      if (!err.message.includes('already been added')) {
        console.warn(`[sfu] AudioWorklet load warning (${mod}):`, err.message);
      }
    }
  }

  _captureNode = new AudioWorkletNode(ctx, 'audio-capture-processor');

  // Register encode callback — fires when WebCodecs produces an Opus packet
  // (zero pipeline delay: the encoded data corresponds to the frame just fed in)
  setOnEncoded((encoded) => {
    // Capture current sequence/timestamp at the moment the encoder produces output.
    // For WebCodecs this fires asynchronously (same task, microtask, or next task
    // depending on browser), so we snapshot seq/timestamp here for accuracy.
    const seq = _seqNum & 0xFFFF;
    _seqNum++;
    const timestamp = ((performance.now() - _joinTimestamp) | 0) >>> 0;
    const flagSilent = _silentFrameCount > 3;
    const flags = (opusSupported() ? 0x01 : 0x00) | (flagSilent ? 0x02 : 0x00);

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
  });

  _captureNode.port.onmessage = (e) => {
    if (state.isMuted) { _silentFrameCount = 0; return; }
    const pcmFrame = e.data; // Float32Array, 960 samples

    // Silence detection: find peak amplitude (check every 8th sample)
    let maxAmp = 0;
    for (let i = 0; i < pcmFrame.length; i += 8) {
      const a = Math.abs(pcmFrame[i]);
      if (a > maxAmp) maxAmp = a;
    }
    const isSilent = maxAmp < 0.005;

    if (isSilent) {
      _silentFrameCount++;
      // Stop sending entirely after holdover period (bandwidth saving)
      if (_silentFrameCount > SILENCE_HOLDOVER_FRAMES) return;
    } else {
      _silentFrameCount = 0;
    }

    // Feed PCM to encoder — result delivered via onEncoded callback
    opusEncode(pcmFrame);
  };

  pipelineOutput.connect(_captureNode);
  _captureNode.connect(ctx.destination); // needed to keep worklet alive (outputs silence)

  send('VoiceJoin', { channel: ch });

  // UI updates
  document.getElementById('voice-section').style.display = '';
  document.getElementById('voice-join-btn').style.display = 'none';
  document.getElementById('voice-leave-btn').style.display = '';
  document.getElementById('voice-controls').style.display = '';
  document.getElementById('voice-status').textContent = 'Connected to #' + ch + (opusSupported() ? '' : ' (uncompressed)');

  // Show video area
  const videoArea = document.getElementById('video-area');
  if (videoArea) videoArea.style.display = '';

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
  // Stop capture and audio pipeline
  if (_captureNode) {
    _captureNode.port.onmessage = null;
    _captureNode.disconnect();
    _captureNode = null;
  }
  if (_audioPipeline) {
    _audioPipeline.cleanup();
    _audioPipeline = null;
  }
  if (_captureStream) {
    _captureStream.getTracks().forEach(t => t.stop());
    _captureStream = null;
  }
  state.localStream = null;

  // Stop video capture
  stopVideoCapture('camera');
  stopVideoCapture('screen');

  // Stop all sender playback
  for (const senderId in _senders) {
    cleanupSender(senderId);
  }

  // Stop all video receivers
  for (const key in _videoReceivers) {
    cleanupVideoReceiver(key);
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

  _pendingDecodes.length = 0;
  closeOpus();
  closeVideoCodec();

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
  state.cameraOn = false;
  state.screenShareOn = false;
  _videoPaused = false;

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
  const cameraBtn = document.getElementById('camera-btn');
  if (cameraBtn) cameraBtn.classList.remove('active');
  const screenBtn = document.getElementById('screenshare-btn');
  if (screenBtn) screenBtn.classList.remove('active');

  // Remove video tiles and hide video area
  import('./chat-ui.js').then(m => {
    m.removeAllVideoTiles();
    m.renderVoiceChannelList();
  });
  const videoArea = document.getElementById('video-area');
  if (videoArea) videoArea.style.display = 'none';

  // Remove bandwidth banner
  hideBandwidthBanner();
}

// ── Binary frame handler (called from messages.js) ──

export function handleBinaryFrame(data) {
  if (!state.sfuActive) return;

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

  if (type === 0x01) {
    // Audio frame
    if (data.length < 10) return;
    const senderId = (data[1] << 8) | data[2];
    const seq = (data[3] << 8) | data[4];
    const flags = data[9];
    const isSilent = (flags & 0x02) !== 0;
    const payload = data.slice(10);

    _packetsReceived++;

    const username = state.sfuIdReverse[senderId];
    if (!username) return;
    if (state.isDeafened) return;

    if (payload.length === 0) {
      updateSpeakingIndicator(username, false);
      return;
    }

    // Update jitter estimate for this sender (before decode)
    const sender = ensureSender(senderId, username);
    updateJitter(sender);

    if (isSilent) updateSpeakingIndicator(username, false);

    // Stash decode context so the onDecoded callback can route to the right sender.
    // For PCM fallback, the callback fires synchronously within opusDecode().
    // For WebCodecs, it fires asynchronously but the decoder is single-threaded
    // and preserves order, so a simple queue of pending contexts works.
    _pendingDecodes.push({ senderId, username, seq });
    opusDecode(payload);
    return;
  }

  if (type === 0x04) {
    // Forwarded video frame:
    // [type(1), sender_id(2), seq(2), timestamp(4), flags(1), width(2), height(2), VP8 payload...]
    if (data.length < 14) return;
    handleVideoFrame(data);
    return;
  }
}

// ── Video frame handling ──

function handleVideoFrame(data) {
  const senderId = (data[1] << 8) | data[2];
  // const seq = (data[3] << 8) | data[4]; // Available for future jitter buffering
  const flags = data[9];
  const isKey = (flags & 0x01) !== 0;
  const isScreen = (flags & 0x02) !== 0;
  const width = (data[10] << 8) | data[11];
  const height = (data[12] << 8) | data[13];
  const payload = data.slice(14);

  const username = state.sfuIdReverse[senderId];
  if (!username) return;

  const tileType = isScreen ? 'screen' : 'camera';
  const receiverKey = senderId + ':' + tileType;

  // Ensure video receiver exists
  const receiver = ensureVideoReceiver(receiverKey, senderId, username, tileType, width, height);
  if (!receiver) return;

  // Decode and render to canvas
  if (videoCodecSupported() && receiver.decoder) {
    const decoded = videoDecode(payload, isKey);
    if (decoded) {
      receiver.ctx.drawImage(decoded, 0, 0, receiver.canvas.width, receiver.canvas.height);
      decoded.close();
    }
  } else {
    // Fallback: create an ImageBitmap from the raw data (VP8)
    // For browsers without VideoDecoder, we use a blob approach
    const blob = new Blob([payload], { type: 'video/webm' });
    createImageBitmap(blob).then(bitmap => {
      receiver.ctx.drawImage(bitmap, 0, 0, receiver.canvas.width, receiver.canvas.height);
      bitmap.close();
    }).catch(() => {
      // Fallback rendering not possible without codec
    });
  }
}

function ensureVideoReceiver(key, senderId, username, tileType, width, height) {
  if (_videoReceivers[key]) {
    // Update dimensions if changed
    const r = _videoReceivers[key];
    if (r.canvas.width !== width || r.canvas.height !== height) {
      r.canvas.width = width;
      r.canvas.height = height;
    }
    return r;
  }

  // Create a canvas-based video tile
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');

  // Create a stream from the canvas for the video tile
  const canvasStream = canvas.captureStream(0); // 0 = manual frame request

  // Add as video tile via chat-ui
  import('./chat-ui.js').then(m => {
    m.addVideoTile(username, tileType, canvasStream);
    // Replace the <video> element's source with our canvas for direct rendering
    const tileId = `video-tile-${username}-${tileType}`;
    const tile = document.getElementById(tileId);
    if (tile) {
      const video = tile.querySelector('video');
      if (video) {
        // Instead of using the stream, paint directly via the canvas
        video.style.display = 'none';
        canvas.style.width = '100%';
        canvas.style.height = '100%';
        canvas.style.objectFit = tileType === 'screen' ? 'contain' : 'cover';
        canvas.style.borderRadius = 'inherit';
        tile.appendChild(canvas);
      }
    }
  });

  // Initialize video decoder for this receiver if needed
  let decoder = null;
  if (videoCodecSupported()) {
    try {
      decoder = new VideoDecoder({
        output: (frame) => {
          ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
          // Request canvas stream frame
          if (canvasStream.getVideoTracks().length > 0) {
            try { canvasStream.getVideoTracks()[0].requestFrame(); } catch {}
          }
          frame.close();
        },
        error: (e) => console.warn('[sfu-video] Decoder error for', key, e),
      });
      decoder.configure({ codec: 'vp8' });
    } catch (e) {
      console.warn('[sfu-video] Failed to create decoder for', key, e);
      decoder = null;
    }
  }

  _videoReceivers[key] = { canvas, ctx, decoder, username, tileType, senderId, canvasStream };
  return _videoReceivers[key];
}

function cleanupVideoReceiver(key) {
  const r = _videoReceivers[key];
  if (!r) return;
  if (r.decoder && r.decoder.state !== 'closed') {
    try { r.decoder.close(); } catch {}
  }
  if (r.canvas && r.canvas.parentNode) {
    r.canvas.parentNode.removeChild(r.canvas);
  }
  import('./chat-ui.js').then(m => m.removeVideoTile(r.username, r.tileType));
  delete _videoReceivers[key];
}

// ── Video capture + send ──

export async function toggleCamera() {
  if (!state.inVoiceChannel) return;

  if (state.cameraOn) {
    // Turn off camera
    stopVideoCapture('camera');
    state.cameraOn = false;
    const btn = document.getElementById('camera-btn');
    if (btn) btn.classList.remove('active');
    import('./chat-ui.js').then(m => m.removeVideoTile(state.currentUser, 'camera'));
    send('VideoStateChange', { channel: state.voiceChannel, video_on: false, screen_share_on: state.screenShareOn });
  } else {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      _localCameraStream = stream;
      state.cameraOn = true;

      const track = stream.getVideoTracks()[0];
      const settings = track.getSettings();
      const w = settings.width || 640;
      const h = settings.height || 480;

      await startVideoCapture(stream, 'camera', w, h);

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

export async function toggleScreenShare() {
  if (!state.inVoiceChannel) return;

  if (state.screenShareOn) {
    stopVideoCapture('screen');
    state.screenShareOn = false;
    _localScreenStream = null;
    const btn = document.getElementById('screenshare-btn');
    if (btn) btn.classList.remove('active');
    import('./chat-ui.js').then(m => m.removeVideoTile(state.currentUser, 'screen'));
    send('VideoStateChange', { channel: state.voiceChannel, video_on: state.cameraOn, screen_share_on: false });
  } else {
    try {
      const shareAudioBtn = document.getElementById('screen-audio-btn');
      const wantAudio = shareAudioBtn && shareAudioBtn.classList.contains('active');
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: wantAudio,
      });
      _localScreenStream = stream;
      state.screenShareOn = true;

      const track = stream.getVideoTracks()[0];
      const settings = track.getSettings();
      const w = settings.width || 1280;
      const h = settings.height || 720;

      track.onended = () => {
        stopVideoCapture('screen');
        state.screenShareOn = false;
        _localScreenStream = null;
        const btn = document.getElementById('screenshare-btn');
        if (btn) btn.classList.remove('active');
        import('./chat-ui.js').then(m => m.removeVideoTile(state.currentUser, 'screen'));
        send('VideoStateChange', { channel: state.voiceChannel, video_on: state.cameraOn, screen_share_on: false });
      };

      await startVideoCapture(stream, 'screen', w, h);

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

async function startVideoCapture(stream, type, w, h) {
  // Cap resolution for bandwidth
  const maxDim = type === 'screen' ? 1280 : 640;
  if (w > maxDim) {
    const ratio = maxDim / w;
    w = maxDim;
    h = Math.round(h * ratio);
  }
  // Ensure even dimensions (VP8 requirement)
  w = w & ~1;
  h = h & ~1;

  const bitrate = type === 'screen' ? 1000000 : 500000;
  await initVideoCodec(w, h, bitrate);

  const track = stream.getVideoTracks()[0];
  const isScreen = type === 'screen';

  // Use canvas-based frame extraction (works in all browsers)
  const video = document.createElement('video');
  video.srcObject = new MediaStream([track]);
  video.muted = true;
  video.play().catch(() => {});

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');

  const timer = setInterval(() => {
    if (video.readyState < 2) return; // Not enough data yet
    ctx.drawImage(video, 0, 0, w, h);

    if (videoCodecSupported()) {
      // Use VideoFrame from canvas
      const frame = new VideoFrame(canvas, { timestamp: performance.now() * 1000 });
      const encoded = videoEncode(frame);
      frame.close();

      if (encoded) {
        sendVideoFrame(encoded.data, encoded.isKey, isScreen, w, h);
      }
    } else {
      // Fallback: send raw JPEG as payload (lossy but universal)
      canvas.toBlob(blob => {
        if (!blob) return;
        blob.arrayBuffer().then(buf => {
          sendVideoFrame(new Uint8Array(buf), true, isScreen, w, h);
        });
      }, 'image/jpeg', 0.5);
    }
  }, VIDEO_FRAME_INTERVAL);

  if (isScreen) {
    _screenCaptureTimer = { timer, video, canvas };
  } else {
    _videoCaptureTimer = { timer, video, canvas };
  }
}

function stopVideoCapture(type) {
  const capture = type === 'screen' ? _screenCaptureTimer : _videoCaptureTimer;
  if (capture) {
    clearInterval(capture.timer);
    if (capture.video) {
      capture.video.srcObject = null;
      capture.video.remove();
    }
    if (capture.canvas) capture.canvas.remove();
  }
  if (type === 'screen') {
    _screenCaptureTimer = null;
    if (_localScreenStream) {
      _localScreenStream.getTracks().forEach(t => t.stop());
      _localScreenStream = null;
    }
  } else {
    _videoCaptureTimer = null;
    if (_localCameraStream) {
      _localCameraStream.getTracks().forEach(t => t.stop());
      _localCameraStream = null;
    }
  }
}

function sendVideoFrame(payload, isKey, isScreen, width, height) {
  // Build client→server video frame:
  // [type(1), seq(2), timestamp(4), flags(1), width(2), height(2), VP8 payload...]
  const seq = _videoSeqNum & 0xFFFF;
  _videoSeqNum++;
  const timestamp = ((performance.now() - _joinTimestamp) | 0) >>> 0;
  const flags = (isKey ? 0x01 : 0x00) | (isScreen ? 0x02 : 0x00);

  const header = new Uint8Array(12);
  header[0] = 0x04; // type: video
  header[1] = (seq >> 8) & 0xFF;
  header[2] = seq & 0xFF;
  header[3] = (timestamp >> 24) & 0xFF;
  header[4] = (timestamp >> 16) & 0xFF;
  header[5] = (timestamp >> 8) & 0xFF;
  header[6] = timestamp & 0xFF;
  header[7] = flags;
  header[8] = (width >> 8) & 0xFF;
  header[9] = width & 0xFF;
  header[10] = (height >> 8) & 0xFF;
  header[11] = height & 0xFF;

  const frame = new Uint8Array(12 + payload.length);
  frame.set(header);
  frame.set(payload, 12);
  sendBinary(frame);
}

// ── Bandwidth pause/resume handlers ──

export function handleVideoPaused(reason) {
  _videoPaused = true;
  console.log('[sfu] Video paused by server:', reason);

  // Close all remote video receivers/tiles
  for (const key in _videoReceivers) {
    cleanupVideoReceiver(key);
  }

  showBandwidthBanner(reason);
}

export function handleVideoResumed() {
  _videoPaused = false;
  console.log('[sfu] Video resumed by server');
  hideBandwidthBanner();
  // Tiles will reappear as keyframes arrive from senders
}

function showBandwidthBanner(reason) {
  let banner = document.getElementById('video-bandwidth-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'video-bandwidth-banner';
    banner.className = 'video-bandwidth-banner';
    const videoArea = document.getElementById('video-area');
    if (videoArea) {
      videoArea.insertAdjacentElement('afterbegin', banner);
    }
  }
  banner.textContent = 'Video paused — ' + reason + '. Audio continues.';
  banner.style.display = '';
}

function hideBandwidthBanner() {
  const banner = document.getElementById('video-bandwidth-banner');
  if (banner) banner.style.display = 'none';
}

// ── Playback (jitter buffer + Web Audio scheduling) ──

function ensureSender(senderId, username) {
  if (_senders[senderId]) return _senders[senderId];

  const ctx = getAudioContext();
  const gainNode = ctx.createGain();
  const vol = state.userVolumes[username] ?? 1.0;
  gainNode.gain.value = vol;
  gainNode.connect(ctx.destination);

  // Playback worklet: continuous ring-buffer output (no inter-frame clicks)
  let playbackNode = null;
  try {
    playbackNode = new AudioWorkletNode(ctx, 'audio-playback-processor');
    playbackNode.connect(gainNode);
  } catch (err) {
    console.warn('[sfu] Playback worklet failed for sender', senderId, err);
  }

  // Analyser for speaking detection (taps the playback output)
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 256;
  if (playbackNode) playbackNode.connect(analyser);
  const analyserData = new Uint8Array(analyser.frequencyBinCount);

  const analyserInterval = setInterval(() => {
    analyser.getByteFrequencyData(analyserData);
    const avg = analyserData.reduce((a, b) => a + b, 0) / analyserData.length;
    updateSpeakingIndicator(username, avg > 15);
  }, 100);

  _senders[senderId] = {
    username,
    gainNode,
    playbackNode,
    analyser,
    analyserData,
    analyserInterval,
    lastSeq: -1,
    // Adaptive jitter buffer state
    lastArrivalTime: 0,
    jitterEstimate: FRAME_DURATION_MS,
    targetBufferMs: 60,
    // Pre-buffer: hold initial frames before starting playback
    preBuffering: true,
    preBufferQueue: [],
  };
  return _senders[senderId];
}

/** Update adaptive jitter estimate for a sender based on inter-arrival time variance */
function updateJitter(sender) {
  const now = performance.now();
  if (sender.lastArrivalTime > 0) {
    const interArrival = now - sender.lastArrivalTime;
    const deviation = Math.abs(interArrival - FRAME_DURATION_MS);
    // Exponential moving average of jitter
    sender.jitterEstimate = sender.jitterEstimate * (1 - JITTER_ALPHA) + deviation * JITTER_ALPHA;
    // Target buffer = 2.5× jitter estimate, clamped to bounds
    sender.targetBufferMs = Math.max(JITTER_MIN_MS,
      Math.min(JITTER_MAX_MS, sender.jitterEstimate * 2.5));
  }
  sender.lastArrivalTime = now;
}

function cleanupSender(senderId) {
  const s = _senders[senderId];
  if (!s) return;
  if (s.analyserInterval) clearInterval(s.analyserInterval);
  if (s.playbackNode) s.playbackNode.disconnect();
  if (s.gainNode) s.gainNode.disconnect();
  if (s.analyser) s.analyser.disconnect();
  updateSpeakingIndicator(s.username, false);
  delete _senders[senderId];
}

function playAudio(senderId, username, pcmFloat32, seq) {
  const sender = ensureSender(senderId, username);

  // Detect packet loss (sequence gap)
  if (sender.lastSeq >= 0) {
    const expected = (sender.lastSeq + 1) & 0xFFFF;
    if (seq !== expected) {
      const gap = ((seq - expected + 0x10000) & 0xFFFF);
      if (gap < 100) {
        _packetsLost += gap;
      }
    }
  }
  sender.lastSeq = seq;

  if (!sender.playbackNode) return;

  // Pre-buffer: accumulate frames equal to the jitter delay before starting playback.
  // This fills the ring buffer so the worklet has enough data to play continuously.
  if (sender.preBuffering) {
    sender.preBufferQueue.push(pcmFloat32);
    const bufferedMs = sender.preBufferQueue.length * FRAME_DURATION_MS;
    if (bufferedMs < sender.targetBufferMs) return;
    // Flush pre-buffer into the workback worklet
    for (const frame of sender.preBufferQueue) {
      sender.playbackNode.port.postMessage({ pcm: frame });
    }
    sender.preBufferQueue = [];
    sender.preBuffering = false;
    return;
  }

  // Steady state: push decoded PCM directly into the ring buffer
  sender.playbackNode.port.postMessage({ pcm: pcmFloat32 });
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
    const vs = state.peerVideoStates[u];
    let icons = '';
    if (vs) {
      if (vs.video_on) icons += '<span class="voice-icon" title="Camera on">&#x1F4F7;</span>';
      if (vs.screen_share_on) icons += '<span class="voice-icon" title="Sharing screen">&#x1F5A5;</span>';
    }
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
        `<span class="voice-name">${escapeHtml(u)}</span>${icons}${qualityDot}` +
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

/** Toggle RNNoise on the active SFU audio pipeline */
export function toggleRnnoise(enabled) {
  if (_audioPipeline) {
    setRnnoiseEnabled(_audioPipeline, enabled);
  }
}

// ── Cleanup on VoiceUserLeft ──

export function removeSender(username) {
  // Cleanup audio senders
  for (const senderId in _senders) {
    if (_senders[senderId].username === username) {
      cleanupSender(senderId);
    }
  }
  // Cleanup video receivers for this user
  for (const key in _videoReceivers) {
    if (_videoReceivers[key].username === username) {
      cleanupVideoReceiver(key);
    }
  }
}

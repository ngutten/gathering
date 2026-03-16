# Feasibility Analysis: Custom WebRTC Alternative for Gathering

## Context

Gathering currently uses browser WebRTC (`RTCPeerConnection`) for peer-to-peer voice/video chat, with the server acting as a pure signaling relay. We just added an embedded TURN server for NAT traversal. The question: what would it take to replace WebRTC entirely with a custom transport, eliminating all external protocol dependencies?

## The Core Architectural Shift: P2P → SFU

The natural replacement for WebRTC peer-to-peer is a **Server Forwarding Unit (SFU)**: clients send media to the server over the existing WSS connection, and the server relays to other voice channel members. This eliminates ICE/STUN/TURN/SDP entirely — clients just connect to the server they're already connected to.

```
Current (WebRTC P2P):
  Client A ──ICE/STUN/TURN──► Client B  (server only relays signaling)

Proposed (SFU):
  Client A ──WSS──► Server ──WSS──► Client B  (server relays actual media)
```

## What Cannot Be Replaced (Browser APIs We Must Keep)

| API | Why |
|-----|-----|
| `getUserMedia()` | Only way to access microphone/camera in a browser |
| `getDisplayMedia()` | Only way to capture screen |
| `AudioContext` / `GainNode` | Per-user volume control |
| `AnalyserNode` | Speaking detection |

These are Web Audio / Media Capture APIs, not WebRTC. They stay regardless.

## What Gets Replaced (and Difficulty)

| Component | Replaces | Difficulty | Notes |
|-----------|----------|------------|-------|
| Remove ICE/STUN/TURN | `turn.rs`, `turn` crate, client ICE exchange | **Easy** | Pure deletion. Biggest operational win. |
| Remove SDP signaling | ~200 lines of offer/answer/glare handling | **Easy** | Replaced by "join channel, start sending frames" |
| Audio capture + encode | `RTCPeerConnection.addTrack()` | **Medium** | `AudioWorklet` → Opus encode (WebCodecs or WASM) → binary WS |
| Audio playback + jitter buffer | `RTCPeerConnection.ontrack` | **Medium-Hard** | Decode Opus → schedule playback. Jitter buffer is the hard part. |
| Server audio relay | Nothing (server is currently signaling-only) | **Medium** | Receive binary WS frames, fan out to room members |
| Video capture + encode | `RTCPeerConnection.addTrack()` for video | **Hard** | WebCodecs `VideoEncoder` (Chrome/Safari) or `MediaRecorder` (universal) |
| Video playback + decode | `RTCPeerConnection.ontrack` for video | **Hard** | WebCodecs `VideoDecoder` or `MediaSource` API |
| Server video relay | Nothing | **Medium-Hard** | High bandwidth; needs keyframe tracking, backpressure |

## Latency Tradeoff

| Scenario | WebRTC (UDP, P2P) | Custom SFU (TCP/WSS) |
|----------|-------------------|----------------------|
| LAN | 5-15ms | 10-30ms |
| Internet (good) | 20-80ms | 50-150ms |
| Packet loss event | Frame dropped, concealed | TCP retransmit, 200-400ms spike |

Voice chat threshold: <150ms one-way is "toll quality", <300ms is conversational. The SFU approach meets this for LAN and typical internet. TCP head-of-line blocking during packet loss is the main risk — causes latency spikes rather than dropped audio.

## Server Load (SFU)

| Scenario | Inbound | Outbound | Total |
|----------|---------|----------|-------|
| 5 users, audio (32kbps Opus) | 20 KB/s | 80 KB/s | 100 KB/s |
| 10 users, audio | 40 KB/s | 360 KB/s | 400 KB/s |
| 5 users + video (1.5 Mbps) | 937 KB/s | 3.75 MB/s | ~4.7 MB/s |

Audio-only is trivial. Video becomes the bandwidth bottleneck on upload-limited connections but is manageable for small groups. No transcoding — server just forwards opaque encoded frames.

## Two Viable Approaches for Video

### Option A: WebCodecs (lower latency, worse browser support)
- `MediaStreamTrackProcessor` → `VideoEncoder` (VP8/H264) → binary WS → `VideoDecoder` → `MediaStreamTrackGenerator`
- Latency: ~50-100ms (similar to WebRTC)
- **Firefox problem**: WebCodecs video support still limited/behind flags as of early 2026
- Best quality and latency, but requires Firefox fallback

### Option B: MediaRecorder (universal support, higher latency)
- `MediaRecorder` encodes camera/screen to WebM chunks → binary WS → `MediaSource` API for playback
- Latency: 200-500ms (acceptable for camera, fine for screen share)
- Works in Chrome, Firefox, Safari — no compatibility issues
- Simpler implementation, no codec management

**Recommendation: Option B (MediaRecorder) for initial implementation.** It avoids the WebCodecs browser support minefield while still fully replacing WebRTC. Can migrate to WebCodecs later for lower latency.

## The Hybrid Alternative

Custom audio SFU + keep WebRTC for video only. **Not recommended** because keeping WebRTC for video means keeping ICE/STUN/TURN, which is the main operational burden we want to eliminate.

## What's Gained vs. What's Lost

**Gained:**
- Eliminate TURN/STUN/ICE entirely (firewall config, UDP ports, credential rotation, `turn`+`webrtc-util` deps)
- Eliminate SDP signaling complexity (~200 lines of glare handling, signal queues, renegotiation)
- Everything over one WSS connection — works through any corporate proxy
- Server can see media (enables: recording, transcription, noise gate, mixing)
- Dramatically simpler voice.js (~200 lines vs current ~620)

**Lost:**
- ~10-80ms additional latency (TCP vs UDP, two hops vs P2P)
- Browser-native jitter buffer, packet loss concealment, bandwidth estimation (must reimplement basics)
- Server becomes media path (bandwidth cost, single point of failure — but it already is for chat)

## Phased Development Plan

### Phase 0: Audio PoC (1-2 weeks)
- Handle `Message::Binary` in `main.rs` WebSocket handler (currently silently discarded)
- Simple binary frame format: `[type: u8][channel_hash: u32][payload]`
- Client: `AudioWorklet` → Opus encode → binary WS → decode → playback
- Minimal 60ms jitter buffer
- Chrome-only initially

### Phase 1: Production Audio SFU (2-4 weeks)
- Proper frame protocol with sequence numbers, timestamps
- Firefox fallback: WASM Opus encoder/decoder
- Server fan-out with `bytes::Bytes` zero-copy sharing
- Reuse existing `GainNode` volume control, `AnalyserNode` speaking detection
- Mute/deafen controls

### Phase 2: Video via MediaRecorder (2-3 weeks)
- Camera + screen share via `MediaRecorder` → binary WS → `MediaSource` playback
- Server keyframe tracking for late joiners
- Per-client send buffer limits (drop frames for slow receivers)

### Phase 3: Cleanup (1 week)
- Remove `src/turn.rs`, `turn`/`webrtc-util` from `Cargo.toml`
- Remove `IceServer`, SDP signaling protocol types
- Remove `embedded_turn` capability
- Update `voice.js` to new SFU-only path

### Phase 4 (future): WebTransport
- Replace WSS with WebTransport for UDP-like datagrams (eliminates TCP latency concern)
- Blocked on browser support (Chrome yes, Safari/Firefox limited)
- Requires HTTP/3 server stack (quinn/h3 crates)

**Total estimated effort for Phases 0-3: ~6-10 weeks**

## Key Risks

1. **Jitter buffer quality** — WebRTC's is decades-mature. A naive implementation will have audible artifacts. Start with fixed 60-100ms delay buffer; iterate.
2. **MediaRecorder latency floor** — Minimum chunk interval varies by browser. If consistently >500ms for video, may be unacceptable for camera (fine for screen share).
3. **Firefox Opus support** — May need WASM fallback (~200KB binary). Packages exist (`opus-wasm`) and work, but adds complexity.
4. **TCP bursting under load** — WebSocket binary frames may batch, causing playback jitter. Jitter buffer handles this but needs tuning.

## Files Affected

| File | Change |
|------|--------|
| `src/main.rs` | Route `Message::Binary` to hub for media relay |
| `src/hub/voice.rs` | Add `handle_audio_frame()` / `handle_video_frame()` fan-out |
| `static/js/voice.js` | Replace RTCPeerConnection with AudioWorklet + binary WS pipeline |
| `src/protocol.rs` | New SFU message types, remove `IceServer`/`VoiceSignal` |
| `src/turn.rs` | **Delete entirely** (Phase 3) |
| `Cargo.toml` | Remove `turn`, `webrtc-util` deps (Phase 3) |
| New: `static/js/audio-worklet.js` | AudioWorklet processor for PCM capture/playback |

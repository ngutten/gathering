# Video Features & Multiple Voice/Video Channels

## Overview
Extends Gathering's existing WebRTC voice (audio-only, full-mesh, ~5 peers) with video, screen sharing, and proper voice/video channel types with occupancy-based message TTL.

## Design Decisions
- **Voice/text independent**: Clicking a voice channel shows its chat but does NOT auto-join voice. Users explicitly join/leave. You can be in voice channel A while reading text channel B.
- **Occupancy TTL**: 10-min countdown starts when the last person leaves voice. All messages without explicit TTL get bulk-deleted after that.
- **Audio-only users**: No video tile — they only appear in the sidebar voice channel user list. Video grid only shows active video/screen share streams.

## Session 1: Foundation — Channel Types, Multiple Voice Channels, Occupancy TTL

### Database (`src/db.rs`)
- `channel_type TEXT DEFAULT 'text'` column on `channels` table (migration)
- `voice_channel_ttl` table: `channel TEXT PK, empty_since TEXT, default_ttl_secs INTEGER DEFAULT 600`
- Methods: `create_channel_with_type()`, `get_channel_type()`, `list_channels_with_type()`, `mark_voice_channel_occupied()`, `mark_voice_channel_empty()`, `get_voice_channels_pending_expiry()`, `expire_voice_channel_messages()`

### Protocol (`src/protocol.rs`)
- `channel_type: String` on `ChannelInfo` (with `#[serde(default)]`)
- `CreateVoiceChannel { channel }` in `ClientMsg`
- `VoiceChannelOccupancy { channel, users }` in `ServerMsg`

### Hub (`src/hub.rs`)
- Handle `CreateVoiceChannel` — creates channel with type "voice"
- `channel_list_inner` includes `channel_type` from DB
- On VoiceJoin/VoiceLeave/disconnect: track occupancy, broadcast `VoiceChannelOccupancy`
- On last user leaving voice channel: call `mark_voice_channel_empty()`

### Expiry loop (`src/main.rs`)
- Voice channel TTL check alongside existing `purge_expired()` call

### Client UI
- Voice channels sidebar section with join/leave buttons per channel
- `#video-area` container (hidden by default) above `#chat-view`
- Video area shown when user is in ANY voice channel
- Voice channel list items, video area/grid/controls styles
- `voiceChannels`, `activeVoiceChannel` in state (independent of `currentChannel`)
- `renderChannels()` split into text + voice sections
- Clicking voice channel switches text view (loads chat) but does NOT join voice
- Separate join/leave buttons in the voice channel list
- Hide Topics toggle when viewing a voice channel

## Session 2: Video & Screen Sharing

### Protocol
- `VideoStateChange { channel, video_on, screen_share_on }` in `ClientMsg`
- `UserVideoState { channel, username, video_on, screen_share_on }` in `ServerMsg`

### Hub
- `video_on`, `screen_share_on` bools on `Client` struct
- Handle `VideoStateChange`: update client, broadcast `UserVideoState`
- On voice join: send existing users' video states to new joiner

### Client
- `toggleCamera()`: getUserMedia video, add/remove tracks, renegotiate SDP
- `toggleScreenShare()`: getDisplayMedia, add/remove tracks, handle browser stop
- `ontrack` differentiate audio/video, create video tiles
- Video tile management functions
- `renegotiate(targetUser)`: create new offer after track changes
- CSS for `.video-tile` (16:9 aspect) and `.screen-share-tile` (full grid width)

## Session 3: Polish & Edge Cases
- Adaptive grid layout based on participant count
- Screen share as dominant tile with camera tiles in sidebar strip
- Connection quality indicators via `pc.getStats()`
- Reconnection: re-join voice on WebSocket reconnect
- Tab visibility: pause video when tab hidden
- Multi-tab guard
- Voice channel TTL UI

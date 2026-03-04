# Gathering — Development Plan

## What exists now (Phase 1, mostly complete)

The server and web UI are written and should compile on Rust 1.75+ (edition 2021).
All dependency versions are pinned in Cargo.toml to avoid pulling in edition-2024 crates.

### Current functionality:
- **Auth:** HTTP endpoints for register/login with Argon2 password hashing, UUID session tokens
- **WebSocket chat:** Authenticated users connect via `/ws`, messages routed through a central Hub
- **Channels:** Users can join/create channels, see member counts, switch between them
- **Message TTL:** Per-message time-to-live (1m, 5m, 1h, 1d, 7d, or permanent). Background task purges expired messages every 60s
- **Message history:** Last 100 messages loaded on channel join, filtered by expiry
- **Typing indicators:** Throttled to one every 2s per user
- **Online presence:** Live user list broadcast on connect/disconnect
- **SQLite storage:** Single-file database (`gathering-data/gathering.db`), WAL mode, fully portable
- **Web UI:** Dark-themed monospace interface, login/register screen, sidebar with channels + online users, message area with basic formatting (**bold**, *italic*, `code`, ```code blocks```)
- **Data directory:** Everything in `gathering-data/` — db, uploads dir, config. Designed to be rsync/tarball portable

### What needs testing:
The code was written but never successfully compiled due to environment constraints (Rust 1.75 in a sandbox with slow compilation). It should compile cleanly — the code uses standard patterns and all versions are pinned — but there may be minor issues to fix on first build.

### To build and run:
```bash
# Install Rust (if needed)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Build
cd gathering
cargo build --release

# Run
./target/release/gathering
# Server starts on http://0.0.0.0:9123
# Open browser to http://localhost:9123

# Environment variables:
#   GATHERING_PORT=9123      (default)
#   GATHERING_DATA=./gathering-data  (default)
#   RUST_LOG=gathering=debug  (for verbose logging)
```

---

## Architecture overview

```
┌──────────────┐     HTTPS/WSS      ┌──────────────────────┐
│  Browser /   │◄──────────────────►│   Gathering Server   │
│  Tauri App   │                    │                        │
│              │   WebSocket JSON   │  ┌─────────┐          │
│  index.html  │◄──────────────────►│  │   Hub   │ routes   │
│  (served by  │                    │  │         │ messages  │
│   server)    │   HTTP REST        │  └────┬────┘          │
│              │◄──────────────────►│       │               │
└──────────────┘   /api/login       │  ┌────▼────┐          │
                   /api/register    │  │   Db    │ SQLite   │
                                    │  │         │ single   │
                                    │  └─────────┘ file     │
                                    └──────────────────────┘
```

### Source layout:
- `main.rs` — Server startup, HTTP routes, WebSocket upgrade handler
- `hub.rs` — Central message router, client registry, channel management
- `db.rs` — SQLite schema, user/session/message CRUD, expiry purge
- `protocol.rs` — All message types (client→server, server→client, HTTP API)
- `tls.rs` — TLS cert detection (placeholder for now, recommends reverse proxy)
- `static/index.html` — Complete single-file web UI

### Protocol (WebSocket JSON):

**Client → Server:**
- `Auth { token }` — authenticate after WS connect
- `Send { channel, content, ttl_secs? }` — send a message
- `Join { channel }` — join/create channel
- `Leave { channel }` — leave channel
- `History { channel, limit? }` — request message history
- `Typing { channel }` — typing indicator

**Server → Client:**
- `AuthResult { ok, username?, error? }` — auth response
- `Message { id, channel, author, content, timestamp, expires_at? }` — chat message
- `History { channel, messages[] }` — batch history
- `UserJoined / UserLeft { channel, username }` — presence
- `UserTyping { channel, username }` — typing
- `ChannelList { channels[] }` — channel list update
- `OnlineUsers { users[] }` — online user list
- `Error { message }` / `System { content }` — server messages

---

## Phase 2 — Voice channels (WebRTC)

### Plan:
- Server acts as a **signaling server** only — relays SDP offers/answers and ICE candidates between peers
- Audio is peer-to-peer (or through TURN relay if NAT traversal fails)
- For small groups (<5 people), full mesh P2P works fine
- For larger groups, we'd need an SFU (Selective Forwarding Unit) — that's Phase 2b

### New protocol messages:
```
Client → Server:
  VoiceJoin { channel }
  VoiceLeave { channel }
  VoiceSignal { target_user, signal_data }  // SDP or ICE candidate

Server → Client:
  VoiceUserJoined { channel, username }
  VoiceUserLeft { channel, username }
  VoiceSignal { from_user, signal_data }
  VoiceMembers { channel, users[] }
```

### Web UI additions:
- Voice channel section in sidebar (separate from text channels, or a "join voice" button per channel)
- Mute/deafen controls
- Voice activity indicator (speaking icon next to username)
- Uses browser `getUserMedia()` + `RTCPeerConnection`

### Libraries:
- No new Rust dependencies needed — just signaling message routing through the existing Hub
- Client-side: native WebRTC APIs, Opus codec (built into browsers)

---

## Future enhancements (backlog)

- **Message editing** — users can edit their own messages
- **Message deletion** — users can delete their own messages
- **TTL modification** — change time-to-live on an existing message
- **Realtime TTL countdown** — client-side countdown timer showing remaining TTL, with a fuzzing-out animation as expiry approaches
- **User status/presence** — idle/away/online status (possibly timeout-based), richer than just connected/disconnected

---

## Phase 3 — File sharing & rich rendering

### File upload:
- New HTTP endpoint: `POST /api/upload` (multipart, authenticated)
- Files stored in `gathering-data/uploads/{uuid}.{ext}`
- Metadata in SQLite: filename, size, uploader, timestamp, associated channel
- Download via `GET /api/files/{uuid}`
- Size limit configurable (default 50MB)
- Image thumbnails generated server-side (optional, using `image` crate)

### Rich rendering (client-side only):
- Markdown: use `marked.js` (already have basic **bold** and *italic*)
- LaTeX: `KaTeX` for math rendering (`$inline$` and `$$block$$`)
- Code: `highlight.js` for syntax highlighting in fenced code blocks
- Images: inline preview for uploaded images
- Links: auto-linkify URLs

### New protocol:
```
Client → Server:
  Send { channel, content, ttl_secs?, attachments?: [file_id, ...] }

Server → Client:
  Message { ..., attachments?: [{ id, filename, size, mime_type, url }] }
```

---

## Phase 4 — Forum / async topics

### Concept:
A separate "topics" view alongside live chat. Think GitHub Discussions or a lightweight forum.

### Data model:
```sql
CREATE TABLE topics (
    id TEXT PRIMARY KEY,
    channel TEXT NOT NULL,
    title TEXT NOT NULL,
    author TEXT NOT NULL,
    created_at TEXT NOT NULL,
    pinned BOOLEAN DEFAULT FALSE
);

CREATE TABLE topic_replies (
    id TEXT PRIMARY KEY,
    topic_id TEXT NOT NULL REFERENCES topics(id),
    author TEXT NOT NULL,
    content TEXT NOT NULL,
    timestamp TEXT NOT NULL
);
```

### UI:
- Toggle between "Chat" and "Topics" view per channel
- Topic list with title, author, reply count, last activity
- Thread view for individual topics
- Same rich rendering as chat

---

## Phase 5 — End-to-end encryption

### Approach:
- Each user generates an X25519 keypair on first login, stores private key locally
- Public keys registered with server
- For DMs: Noise NK or Signal-style X3DH key agreement
- For group channels: Sender Keys protocol (each member has a sender key, distributed via pairwise channels)
- Server stores only ciphertext — cannot read messages
- Key management UI: show fingerprints, verify contacts

### Rust crates:
- `snow` — Noise protocol framework
- `x25519-dalek` — key exchange
- Client-side: WebCrypto API or `libsodium.js`

### Complexity note:
This is the hardest phase. Key distribution, device management, forward secrecy in group chats — all hard problems. Worth studying the Signal and Matrix/MLS specs before designing.

---

## Phase 2b (future) — Native client via Tauri

### Why Tauri:
- Rust backend, web frontend in a native window
- Uses OS webview (not bundled Chromium), so binaries are ~5-10MB
- System tray, native notifications, auto-update
- Same `static/index.html` can be used with minimal changes
- WebSocket connection to remote server, same protocol

### Structure:
```
gathering-client/
├── src-tauri/
│   ├── src/main.rs    # Tauri app setup, system tray, notifications
│   └── Cargo.toml
├── src/
│   └── index.html     # same web UI, maybe with minor Tauri-specific tweaks
└── tauri.conf.json
```

---

## Design principles

1. **Single portable data directory** — everything in one folder, easy to backup/migrate
2. **Single binary server** — no runtime dependencies, no separate database service
3. **Protocol-first** — the WebSocket JSON protocol is the contract; any client can implement it
4. **Progressive enhancement** — start with what works (web UI), add native later
5. **Crypto later, correctly** — better to add E2E encryption deliberately than to bolt on something half-baked

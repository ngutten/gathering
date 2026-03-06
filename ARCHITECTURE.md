# Gathering Architecture

Self-hosted encrypted chat server. Rust backend (Axum + SQLite), vanilla JS frontend, no build step.

## Quick Orientation

| What | Where |
|------|-------|
| Server entry point, HTTP routes, WS upgrade | `src/main.rs` |
| WebSocket message hub, client registry | `src/hub/mod.rs` + submodules |
| Database schema, migrations, CRUD | `src/db/mod.rs` + submodules |
| All message types (client/server/HTTP) | `src/protocol.rs` |
| TLS cert detection | `src/tls.rs` |
| Frontend entry point, module wiring | `static/js/app.js` |
| WebSocket transport + API fetch | `static/js/transport.js` |
| Widget system | `static/js/widgets/` |
| HTML shell | `static/index.html` |
| Styles | `static/css/styles.css` |
| Desktop client (Tauri) | `gathering-client/` |
| Runtime data (DB, uploads, certs, config) | `gathering-data/` |

## Program Flow

### Startup (`src/main.rs`)

1. Read env vars (`GATHERING_PORT`, `GATHERING_DATA`, `RUST_LOG`)
2. Open/create SQLite database, run migrations
3. Load `config.json` from data dir (or use defaults)
4. Create `Hub` (holds `Arc<Db>`, client map, voice state)
5. Build Axum router:
   - `GET /` + static files via `ServeDir`
   - `POST /api/register`, `POST /api/login`, `POST /api/logout`
   - `GET /api/server-info` (registration mode)
   - `POST /api/upload` (multipart, authenticated)
   - `GET /api/files/:id` (authenticated download)
   - `GET /ws` (WebSocket upgrade)
6. Start TLS server (if certs exist) + HTTP redirect server
7. Spawn background task: purge expired messages every 60s

### WebSocket Lifecycle

```
Browser                         Server
  |                               |
  |-- GET /ws (upgrade) --------->|  main.rs: ws_handler()
  |<-- 101 Switching Protocols ---|
  |                               |  hub: register new Client (gets numeric id)
  |-- Auth { token } ------------>|  hub: validate session, set username
  |<-- AuthResult { ok, ... } ----|
  |<-- ChannelList ---------------|  auto-sent on auth
  |<-- OnlineUsers ---------------|
  |<-- DMList --------------------|
  |                               |
  |-- Join { channel } ---------->|  hub: add to channel, broadcast UserJoined
  |<-- History { messages } ------|  hub: load last 100 from DB
  |                               |
  |-- Send { channel, content } ->|  hub: validate, store in DB, broadcast Message
  |<-- Message { ... } ----------|  (broadcast to all channel members)
  |                               |
  |-- (disconnect) -------------->|  hub: unregister, broadcast UserLeft, voice cleanup
```

### Hub Architecture (`src/hub/`)

The `Hub` is the central message router. It holds:
- `clients: Mutex<HashMap<usize, Client>>` — all connected WebSocket clients
- `db: Arc<Db>` — shared database handle
- `voice_channels: Mutex<HashMap<String, HashSet<usize>>>` — voice channel membership

Each `Client` has a `tx` (mpsc sender) for outbound messages, plus username, joined channels, and voice state.

`hub/mod.rs` dispatches `ClientMsg` variants to handler submodules:

| Module | Handles |
|--------|---------|
| `hub/chat.rs` | Send, Join, Leave, History, Typing |
| `hub/messages.rs` | EditMessage, DeleteMessage |
| `hub/voice.rs` | VoiceJoin, VoiceLeave, VoiceSignal, VideoStateChange, CreateVoiceChannel |
| `hub/topics.rs` | CreateTopic, ListTopics, GetTopic, TopicReply, PinTopic, Edit/DeleteTopic |
| `hub/admin.rs` | Settings, Invites, Roles, DeleteChannel |
| `hub/dms.rs` | StartDM, ListDMs |
| `hub/encryption.rs` | Key exchange, channel encryption |
| `hub/files.rs` | ListMyFiles, SetFilePinned, DeleteFile |
| `hub/access.rs` | SetChannelRestricted, Add/RemoveChannelMember |
| `hub/widgets.rs` | WidgetMessage, SaveWidgetState, LoadWidgetState |

### Database (`src/db/`)

SQLite via `rusqlite`, WAL mode, single-file at `gathering-data/gathering.db`. The `Db` struct wraps `Mutex<Connection>`. Submodules mirror the hub's domain split:

| Module | Tables |
|--------|--------|
| `db/auth.rs` | `users`, `sessions` |
| `db/channels.rs` | `channels` |
| `db/messages.rs` | `messages` |
| `db/topics.rs` | `topics`, `topic_replies` |
| `db/dms.rs` | `dm_members` |
| `db/members.rs` | `channel_members` |
| `db/files.rs` | `files` |
| `db/roles.rs` | `roles`, `role_permissions`, `user_roles` |
| `db/invites.rs` | `invites` |
| `db/encryption.rs` | `public_keys`, `channel_keys` |
| `db/settings.rs` | `settings` |
| `db/preferences.rs` | `user_preferences` |
| `db/voice.rs` | `voice_channel_ttl` |
| `db/search.rs` | Full-text message search |
| `db/quotas.rs` | Per-user disk quotas |
| `db/widget_state.rs` | `widget_state` |

### Frontend (`static/js/`)

Vanilla ES modules, no build step. `app.js` is the entry point that imports everything and wires `window.*` bindings for `onclick` handlers in HTML.

| Module | Role |
|--------|------|
| `app.js` | Entry point, imports all modules, wires events to `window.*` |
| `state.js` | Centralized state object + event emitter (`on`/`emit`) |
| `transport.js` | WebSocket connect/send/reconnect + `apiFetch()` helper |
| `config.js` | `apiUrl()`, `wsUrl()`, `fileUrl()`, Tauri detection |
| `auth.js` | Login, register, logout, server info check |
| `messages.js` | `handleServerMsg()` — routes all `ServerMsg` types to UI |
| `chat-ui.js` | Channel list rendering, message display, typing indicators, DMs |
| `input.js` | Message compose, file attach, edit/delete, channel join |
| `render.js` | Markdown/KaTeX/code rendering, `escapeHtml()`, attachment HTML |
| `voice.js` | WebRTC peer connections, mute/deafen, camera/screenshare |
| `topics.js` | Forum-style topic threads |
| `admin.js` | Admin panel (settings, invites, roles) |
| `crypto.js` | E2E encryption (libsodium): key generation, channel key exchange |
| `files.js` | File manager panel |
| `search.js` | Message search UI |
| `emoji.js` | Emoji picker |
| `notifications.js` | Browser notification preferences |
| `tauri-bridge.js` | Tauri desktop client integration shim |
| `sodium-loader.js` | Loads libsodium-wrappers |

### Protocol (`src/protocol.rs`)

All messages are JSON over WebSocket, tagged with `"type"`. The `ClientMsg` enum covers ~40 message types from the client; `ServerMsg` covers ~40 response/broadcast types. HTTP is used only for auth (register/login/logout), file upload/download, and server info.

### Channel Access Model

- Channels are **open by default** (any authenticated user can join)
- Channels can be **restricted** — only members in `channel_members` can access
- DM channels use a separate `dm_members` table
- `db.can_access_channel()` is the unified access check
- Channel creator or admin can toggle restriction and manage members

### E2E Encryption

- Client-side libsodium (X25519 keypairs)
- Per-channel symmetric keys, encrypted to each member's public key
- Server stores only ciphertext — cannot read encrypted messages
- Key exchange via `ProvideChannelKey` / `RequestChannelKey` protocol messages

---

## Widget System

Widgets are sandboxed mini-applications that run client-side and communicate via the existing WebSocket protocol. The server treats widget messages as opaque broadcasts — no widget-specific logic on the backend.

### For Widget Developers

To create a new widget, you need **one file** in `static/js/widgets/` and **one import line** in `app.js`. No server changes required.

### The Widget API (`static/js/widgets/widget-api.js`)

Every widget extends `WidgetBase`:

```javascript
import { WidgetBase, registerWidget } from './widget-api.js';

class MyWidget extends WidgetBase {
  // Called once when the widget is opened. Render your UI into this.container.
  activate() {
    this.container.innerHTML = `<div class="widget-header">
      <span class="widget-title">My Widget</span>
      <button class="widget-close"
        onclick="deactivateCurrentWidget('${this.id}')">&times;</button>
    </div>
    <div>Your widget UI here</div>`;
  }

  // Called when another user sends a message to this widget.
  // fromUser: string, action: string you define, data: any JSON-serializable object
  onMessage(fromUser, action, data) {
    if (action === 'my-action') {
      // Update your UI based on the incoming data
    }
  }

  // Send a message to all other users who have this widget open.
  // Call this.send(action, data) from your event handlers.
  // Example: this.send('my-action', { value: 42 });

  // Return your current state so latecomers can sync.
  // Return null if there's nothing to share.
  getState() {
    return { /* your serializable state */ };
  }

  // Restore state from another user's snapshot (called once on join).
  setState(data) {
    // Rebuild your UI from data
  }

  // Called when the widget is closed. Clean up event listeners, timers, etc.
  deactivate() {
    this.container.innerHTML = '';
  }
}

// Register: id must be unique, name is shown in the picker UI
registerWidget('my-widget', 'My Widget', MyWidget);
```

### Constructor

`WidgetBase` constructor receives three arguments (set automatically by the framework):

| Param | Type | Description |
|-------|------|-------------|
| `widgetId` | `string` | The registered widget ID (e.g. `'dice-roller'`) |
| `channel` | `string` | The channel the widget is active in |
| `container` | `HTMLElement` | A `<div>` in the widget panel — render your UI here |

These are available as `this.id`, `this.channel`, `this.container`.

### Lifecycle

1. User clicks widget in picker -> `activateWidget(channel, widgetId)` is called
2. Framework creates a container `<div>`, instantiates your class, calls `activate()`
3. Framework sends `_request_state` to other users who have the widget open
4. If another user responds, your `setState(data)` is called once with their snapshot
5. While active, `onMessage(fromUser, action, data)` is called for each incoming broadcast
6. When user closes the widget, `deactivate()` is called and the container is removed

### Sending Messages

Call `this.send(action, data)` to broadcast to all channel members who have the widget open:

```javascript
this.send('move-piece', { pieceId: 'knight', x: 3, y: 5 });
```

Under the hood this sends a `WidgetMessage` through the WebSocket. The server validates auth and channel membership, then broadcasts a `WidgetBroadcast` to all channel members. Your widget's `onMessage` is called on every client that has the widget active (including the sender via the broadcast echo).

### Server-Side Persistence

Widgets that need to persist state across sessions can use:

```javascript
// Save state to server (stored per channel+widget_id, max 512KB)
this.saveToServer({ board: this.boardState });

// Load state from server
this.loadFromServer();

// Handle the response in:
onServerResponse(type, data) {
  if (type === 'WidgetStateLoaded' && data.state) {
    this.restoreBoard(data.state.board);
  }
}
```

### Wiring Into the App

After creating your widget file, add two lines to `app.js`:

```javascript
// 1. Import to trigger registration
import './widgets/my-widget.js';

// 2. If your widget has window-level onclick handlers, import and expose them:
import { myAction } from './widgets/my-widget.js';
window.myAction = myAction;
```

### What Your Widget Can Access

| Resource | Access |
|----------|--------|
| `this.container` | Full DOM control within your container div |
| `this.send(action, data)` | Broadcast to channel members |
| `this.saveToServer(state)` / `this.loadFromServer()` | Persist state |
| `this.channel` | Current channel name |
| `this.id` | Your widget ID |
| `state.currentUser` (import from `../state.js`) | Current username |
| `escapeHtml()` (import from `../render.js`) | XSS-safe HTML escaping |

### Existing Widgets

| Widget | File | Description |
|--------|------|-------------|
| Dice Roller | `widgets/dice-roller.js` | Shared dice rolling with notation parser (`2d6+3`) |
| Initiative Tracker | `widgets/initiative.js` | Turn order tracker for tabletop games |
| Shared Radio | `widgets/radio.js` | Synchronized audio player with DJ mode |
| Whiteboard | `widgets/whiteboard.js` | Collaborative vector drawing with PDF export |

### Server-Side Widget Handling (`src/hub/widgets.rs`)

The server handles three widget message types:

- **`WidgetMessage`** — Validates auth + channel membership, then broadcasts as `WidgetBroadcast` to all channel members. Limits: widget_id 64 chars, action 128 chars, data 64KB.
- **`SaveWidgetState`** — Stores JSON state in `widget_state` table (per channel+widget_id). Limit: 512KB.
- **`LoadWidgetState`** — Returns stored state for a channel+widget_id pair.

No widget-specific logic exists on the server. All game/app logic lives in the client-side widget code.

### Presence System

The widget framework includes automatic presence tracking. When a user activates or deactivates a widget, a meta-message is broadcast so other users can see which widgets are in use. The widget picker UI shows badges for remotely-active widgets, letting users join ongoing sessions.

---

## Build & Run

```bash
cargo build --release
GATHERING_DATA=./gathering-data ./target/release/gathering
# Server starts on https://0.0.0.0:9123 (or http if no TLS certs)
```

Environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `GATHERING_PORT` | `9123` | Server listen port |
| `GATHERING_DATA` | `./gathering-data` | Data directory path |
| `RUST_LOG` | `gathering=info` | Log verbosity |

## Data Directory

```
gathering-data/
  gathering.db    SQLite database (WAL mode)
  uploads/        User-uploaded files
  config.json     Server configuration (optional)
  cert.pem        TLS certificate (optional)
  key.pem         TLS private key (optional)
```

All state is in this directory. Back up or migrate by copying it.

# Gathering Configuration Guide

All server settings live in `config.json` in the data directory. Settings changed through the admin panel are written back to this file automatically, so it always reflects the current state of the server.

On startup, the server reads `config.json` and seeds the database. If no file exists, defaults are used.

---

## Environment Variables

Set these before starting the server.

| Variable | Default | Description |
|----------|---------|-------------|
| `GATHERING_DATA` | `./gathering-data` | Path to the data directory (DB, uploads, certs, config) |
| `GATHERING_PORT` | from config.json, or `9123` | HTTPS listen port |
| `GATHERING_HTTP_PORT` | from config.json, or port + 1 | HTTP-to-HTTPS redirect port |
| `RUST_LOG` | `gathering=info` | Log verbosity (`debug`, `trace`, etc.) |

Port precedence: env var > config.json > default.

---

## config.json

Optional file at `<data-dir>/config.json`. Created automatically when an admin changes settings through the web UI.

### Full example

```json
{
  "port": 9123,
  "http_port": 9124,
  "admins": ["alice", "bob"],
  "server_name": "My Server",
  "server_icon": "https://example.com/icon.png",
  "allow_key_backup": true,
  "registration_mode": "open",
  "channel_creation": "all",
  "enabled_widgets": null,
  "default_roles": {
    "user": [
      "send_message",
      "edit_own_message",
      "delete_own_message",
      "create_topic",
      "edit_own_topic",
      "delete_own_topic",
      "create_channel",
      "upload_file"
    ],
    "admin": ["*"]
  }
}
```

### Reference

#### `port`

- **Type:** integer
- **Default:** `9123`
- **Description:** HTTPS listen port. Can be overridden by `GATHERING_PORT` env var.

#### `http_port`

- **Type:** integer or null
- **Default:** `port + 1`
- **Description:** HTTP port that redirects all requests to HTTPS. Set explicitly if you need a specific port. Can be overridden by `GATHERING_HTTP_PORT` env var.

#### `admins`

- **Type:** array of strings
- **Default:** `[]`
- **Description:** Usernames that are automatically assigned the `admin` role on registration and on every server start. This is the only way to bootstrap the first admin account. Not changeable through the admin panel.

#### `server_name`

- **Type:** string or null
- **Default:** null (shows "Gathering")
- **Admin panel:** Settings tab > Server Name
- **Description:** Display name shown in the sidebar header, auth screen, and Tauri server rail.

#### `server_icon`

- **Type:** string or null
- **Default:** null
- **Admin panel:** Settings tab > Server Icon
- **Description:** URL for the server icon. Must be an `https://`, `http://`, or `/api/files/...` URL.

#### `registration_mode`

- **Type:** string
- **Values:** `"open"`, `"closed"`, `"invite"`
- **Default:** `"open"`
- **Admin panel:** Settings tab > Registration Mode
- **Description:**
  - `open` -- anyone can register
  - `closed` -- registration is disabled entirely
  - `invite` -- registration requires a valid invite code (generated in the Invites tab)

#### `channel_creation`

- **Type:** string
- **Values:** `"all"`, `"admin"`
- **Default:** `"all"`
- **Admin panel:** Settings tab > Channel Creation
- **Description:**
  - `all` -- any user with the `create_channel` permission can create channels
  - `admin` -- only admins can create channels

#### `allow_key_backup`

- **Type:** boolean
- **Default:** `true`
- **Admin panel:** not exposed (config.json only)
- **Description:** Whether to allow users to store encrypted E2E key backups on the server. When `false`:
  - The server rejects `SetKeyBackup` and `DeleteKeyBackup` requests with an error.
  - `GetKeyBackup` returns `NoKeyBackup` regardless of stored data.
  - The `key_backup` capability is not advertised, so clients hide the "Sync" button.
  - Existing backups are not deleted, but become inaccessible until re-enabled.

  Set to `false` on high-security servers where you don't want passphrase-protected private keys stored server-side at all. Users can still export/import keys manually via file.

#### `enabled_widgets`

- **Type:** array of strings, or null
- **Default:** `null` (all widgets enabled)
- **Admin panel:** not exposed (config.json only)
- **Description:** Controls which widgets are available to users. When `null` or omitted, all widgets are enabled. When set to a list, only the specified widget IDs are available; all others are hidden from the picker and rejected by the server.

  Built-in widget IDs: `"dice-roller"`, `"initiative"`, `"radio"`, `"whiteboard"`, `"piano"`, `"goban"`

  Examples:
  ```json
  "enabled_widgets": null
  ```
  All widgets enabled (default).

  ```json
  "enabled_widgets": ["dice-roller", "whiteboard"]
  ```
  Only Dice Roller and Whiteboard are available.

  ```json
  "enabled_widgets": []
  ```
  All widgets disabled. The widget toolbar button is hidden.

#### `default_roles`

- **Type:** object mapping role names to permission arrays
- **Default:**
  ```json
  {
    "user": ["send_message", "edit_own_message", "delete_own_message",
             "create_topic", "edit_own_topic", "delete_own_topic",
             "create_channel", "upload_file"],
    "admin": ["*"]
  }
  ```
- **Description:** Roles and their permissions, seeded into the database on startup. The `user` role is automatically assigned to every new account. The `admin` role grants all permissions via the `*` wildcard. Once seeded, roles can also be managed at runtime via the admin panel's Roles tab.

---

## Admin Panel

The admin panel is accessible via the gear icon in the sidebar (visible to users with the `manage_settings`, `manage_invites`, or `manage_roles` permission).

Changes made in the admin panel take effect immediately and are written back to `config.json`. If you hand-edit `config.json` while the server is running, the changes take effect on the next restart (and will overwrite any admin panel changes made in the interim for the same fields).

### Settings Tab

| Setting | config.json field | Description |
|---------|------------------|-------------|
| Registration Mode | `registration_mode` | Controls whether new users can register |
| Channel Creation | `channel_creation` | Controls who can create channels |
| Server Name | `server_name` | Display name for the server |
| Server Icon | `server_icon` | Icon URL for the server |

### Invites Tab

- Generate invite codes (used when registration mode is `invite`)
- List all invites with usage status

### Roles Tab

- Create, edit, and delete custom roles
- Set permissions per role
- Set disk quotas per role
- Assign/remove roles for individual users

---

## Roles and Permissions

Roles are the authorization layer. Each role has a set of permissions and an optional disk quota. Users can have multiple roles; permissions and quotas are combined (union of permissions, max of quotas).

### Built-in Roles

| Role | Permissions | Notes |
|------|------------|-------|
| `user` | send_message, edit_own_message, delete_own_message, create_topic, edit_own_topic, delete_own_topic, create_channel, upload_file | Auto-assigned on registration |
| `admin` | `*` (all) | Assigned via config.json `admins` list or admin panel |

### Available Permissions

| Permission | Description |
|-----------|-------------|
| `send_message` | Send messages in channels |
| `edit_own_message` | Edit own messages |
| `delete_own_message` | Delete own messages |
| `delete_any_message` | Delete any user's messages |
| `create_topic` | Create forum topics |
| `edit_own_topic` | Edit own topics |
| `delete_own_topic` | Delete own topics |
| `create_channel` | Create new channels (when channel_creation is `all`) |
| `upload_file` | Upload files |
| `pin_message` | Pin/unpin messages |
| `pin_topic` | Pin/unpin topics |
| `manage_settings` | Change server settings in admin panel |
| `manage_invites` | Create and list invite codes |
| `manage_roles` | Create/edit/delete roles and assign them to users |
| `delete_channel` | Delete channels |
| `*` | Wildcard -- grants all permissions |

### Disk Quotas

Each role can specify a `disk_quota_mb` value (set in the admin panel's Roles tab). A value of `0` means unlimited. When a user exceeds their quota, the server auto-deletes their oldest unpinned files to make room for the new upload.

---

## Hard-Coded Limits

These are not configurable and are set in the source code:

| Limit | Value | Location |
|-------|-------|----------|
| Max file upload size | 50 MB | `src/main.rs` |
| Max message size | 32 KB | `src/hub/chat.rs` |
| Max channel name length | 64 characters | `src/hub/chat.rs` |
| Max topic title length | 256 characters | `src/hub/topics.rs` |
| Max topic body size | 64 KB | `src/hub/topics.rs` |
| Message history per request | 100 messages | `src/hub/chat.rs` |
| Session expiry | 30 days | `src/db/auth.rs` |
| Rate limit (login/register) | 10 requests/IP/minute | `src/main.rs` |
| Max reactions per message | 20 | `src/hub/reactions.rs` |
| Max widget state size | 512 KB | `src/hub/widgets.rs` |
| Max widget data per message | 64 KB | `src/hub/widgets.rs` |

---

## TLS

Gathering uses TLS by default. Place `cert.pem` and `key.pem` in the data directory. If no certificates are found, self-signed certificates are generated automatically on first run.

For production, you can either:
1. Use your own certificates (e.g., from Let's Encrypt)
2. Use a reverse proxy (nginx, caddy) for TLS termination

---

## Code Integrity (Browser Clients)

Gathering includes a service worker (`sw.js`) that provides TOFU-based code integrity monitoring for browser clients:

- On first load, the service worker pins SHA-256 hashes of all JavaScript files.
- On subsequent page loads, it compares served files against pinned hashes.
- If any file has changed, a full-screen warning is displayed with the expected and actual hashes.
- Users can accept the update (legitimate server upgrade), accept all changes, or close the page.

This protects established browser users against a compromised server silently injecting modified client code. It does not protect against compromise at the time of first visit (inherent limitation of the TOFU model). For strongest security guarantees, use the standalone Tauri client.

---

## Data Directory

```
gathering-data/
  gathering.db    SQLite database (WAL mode)
  uploads/        User-uploaded files
  config.json     Server configuration (auto-updated by admin panel)
  cert.pem        TLS certificate (optional)
  key.pem         TLS private key (optional)
```

All state is in this directory. Back up or migrate by copying it.

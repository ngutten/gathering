# Gathering

Self-hosted, encrypted chat server. Single binary, single SQLite file, no external dependencies.

## Quick start

```bash
# Build
cargo build --release

# Run (starts on port 9123)
./target/release/gathering

# Open http://localhost:9123 in a browser
# Register a user, start chatting
```

## Configuration

Environment variables:

| Variable | Default | Description |
|---|---|---|
| `GATHERING_PORT` | `9123` | Server listen port |
| `GATHERING_DATA` | `./gathering-data` | Data directory path |
| `RUST_LOG` | `gathering=info` | Log level |

Place a `config.json` in the data directory to configure admin accounts, roles, server branding, and security options. Runtime settings (registration mode, server name/icon) are managed through the admin panel.

See [CONFIGURATION.md](CONFIGURATION.md) for the full reference.

## Data directory

All server state lives in a single portable directory:

```
gathering-data/
├── gathering.db   # SQLite database (users, messages, channels)
├── uploads/        # Shared files (Phase 3)
├── cert.pem        # TLS certificate (optional)
└── key.pem         # TLS private key (optional)
```

Back up by copying this directory. Migrate by moving it to another machine.

## Features

- **Channels** — create and join chat channels
- **Message TTL** — set per-message expiry (1m to 7d, or permanent)
- **Typing indicators** — see who's typing
- **Online presence** — see who's connected
- **Basic formatting** — `**bold**`, `*italic*`, `` `code` ``, ` ```code blocks``` `
- **Argon2 auth** — password hashing with Argon2id
- **Portable storage** — single SQLite file, no database service needed

## TLS

For production, either:
1. Place `cert.pem` and `key.pem` in the data directory
2. Use a reverse proxy (nginx, caddy) for TLS termination — recommended

## Security

See [SECURITY.md](SECURITY.md) for the E2E encryption guide — what it protects, what it doesn't, and recommendations for users and server admins.

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full codebase walkthrough, including the widget development guide.

## Building from source

Requires Rust 1.75+ (recommend latest stable).

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
cargo build --release
```

Cross-platform binaries are built automatically via GitHub Actions on push to `main` or tag push.

## License

CC0

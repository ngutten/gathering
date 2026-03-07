# TODO

## Reliability & Operations
- [x] Automated tests (90 tests: 64 DB-layer, 26 hub integration — see tests/)
- [x] Database backup endpoint (POST /api/backup, admin-only, SQLite `.backup`)
- [x] Graceful shutdown (drain WebSocket connections and DB writes on SIGTERM)

## User-Facing Features
- [x] Message reactions (emoji reactions on chat messages)
- [x] User profiles (avatars, status messages, about text)
- [x] Message pinning in channels (pin/unpin, pinned messages panel)

## Infrastructure
- [ ] Multi-device E2E key sync

## Polish
- [x] Accessibility (ARIA labels, keyboard navigation, screen reader support)
- [x] Mobile-responsive CSS improvements

## Already Implemented
- Reply-to messages (full implementation: DB fields, protocol, UI with click-to-scroll)
- Unread indicators (client-side tracking with badges, mention highlights, localStorage persistence)

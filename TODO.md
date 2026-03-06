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
- [ ] WebSocket reconnect resilience (missed-message catch-up via last-seen message ID)
- [ ] Push notifications (Web Push API for mentions/DMs when tab is backgrounded)
- [ ] Multi-device E2E key sync

## Polish
- [ ] Accessibility (ARIA labels, keyboard navigation, screen reader support)
- [ ] Mobile-responsive CSS improvements

## Already Implemented
- Reply-to messages (full implementation: DB fields, protocol, UI with click-to-scroll)
- Unread indicators (client-side tracking with badges, mention highlights, localStorage persistence)

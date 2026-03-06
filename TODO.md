# TODO

## Reliability & Operations
- [x] Automated tests (71 tests: 53 DB-layer, 18 hub integration — see tests/)
- [ ] Database backup endpoint or scheduled job (SQLite `.backup`)
- [ ] Graceful shutdown (drain WebSocket connections and DB writes on SIGTERM)

## User-Facing Features
- [ ] Message reactions (emoji reactions on chat messages)
- [ ] User profiles (avatars, status messages, about text)
- [ ] Message pinning in channels (topics have pinning, but chat messages don't)

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

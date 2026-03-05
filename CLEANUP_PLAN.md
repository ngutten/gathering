# Gathering Cleanup Plan

## Security Issues (fix first)

| # | Severity | Issue | Location |
|---|----------|-------|----------|
| S1 | **CRITICAL** | XSS via `innerHTML` — URL in `href` attribute not attribute-escaped; invite code embedded raw into `onclick` handler; role permissions injected into innerHTML unescaped | `render.js:65`, `admin.js:94,127` |
| S2 | **CRITICAL** | Unauthenticated file downloads — `/api/files/:id` has no auth check; anyone with a UUID can download any file, including from encrypted channels | `main.rs:419-489` |
| S3 | **CRITICAL** | Wildcard CORS — `allow_origin(Any)` lets any malicious website make authenticated requests on behalf of logged-in users | `main.rs:127-130` |
| S4 | **HIGH** | No session expiry — tokens live forever in the DB; no logout endpoint deletes them server-side | `db.rs:313-347` |
| S5 | **HIGH** | No rate limiting on `/api/register` and `/api/login` — combined with 6-char minimum password, brute force is feasible | `main.rs:177-280` |
| S6 | **HIGH** | Full app served over plaintext HTTP on secondary port — passwords and tokens transmitted in cleartext | `main.rs:149-156` |
| S7 | **MEDIUM** | No channel membership checks — users can send messages to and pull history from any channel without joining | `hub.rs:187-220, 327` |
| S8 | **MEDIUM** | Permissions defined but not enforced — `send_message`, `create_topic`, `upload_file` permissions are never checked | `hub.rs` |
| S9 | **MEDIUM** | `Content-Disposition` header injection — unsanitized filename allows `"` or newline injection | `main.rs:443` |
| S10 | **MEDIUM** | Any user can overwrite any other user's channel encryption key via `ProvideChannelKey` | `hub.rs:1313-1333` |
| S11 | **MEDIUM** | No server-side validation on channel names, message size, topic title/body length, or `limit` parameters | `hub.rs` throughout |
| S12 | **LOW** | External KaTeX loaded from CDN without SRI hashes | `index.html:7-8` |
| S13 | **LOW** | Invite codes truncated to 8 hex chars (~32 bits), brute-forceable | `db.rs:973` |
| S14 | **LOW** | Mutex poisoning — any panic under `conn.lock().unwrap()` crashes the entire server | `db.rs` throughout |

## Code Organization Issues

| # | Issue | Location |
|---|-------|----------|
| O1 | **`hub.rs` is 1682 lines with a single ~1400-line `handle_message` match** — needs decomposition into handler modules (chat, voice, topics, admin, encryption, files, DMs) | `hub.rs:160-1567` |
| O2 | **`db.rs` is 1429 lines** mixing schema, migrations, and CRUD for 12+ domains — should be split into domain-specific modules | `db.rs` |
| O3 | **Auth+permission check boilerplate repeated ~25 times** — extract a `require_auth_and_permission()` helper | `hub.rs` throughout |
| O4 | **DB migration pattern repeated 12 times** — extract a `migrate_add_column()` helper | `db.rs:149-266` |
| O5 | **Attachment rendering duplicated** between `chat-ui.js` and `render.js` — `chat-ui.js` should call `renderAttachmentsHtml` | `chat-ui.js:57-73`, `render.js:194-211` |
| O6 | **TTL badge rendering duplicated** — `chat-ui.js` should call `renderTtlBadge` | `chat-ui.js:20-27`, `render.js:184-192` |
| O7 | **Encrypt/decrypt patterns duplicated 6+ times** across `input.js`, `topics.js`, `messages.js`, `chat-ui.js` — extract helpers | Multiple files |
| O8 | **60+ functions attached to `window.*`** as a flat global namespace — fragile, no organization | `app.js:25-84` |
| O9 | **Circular dependency workarounds** — `voice.js` and `chat-ui.js` use dynamic `import()` to avoid cycles | `voice.js`, `chat-ui.js:340` |
| O10 | **Split state** — `files.js` and `search.js` maintain module-level state outside centralized `state.js` | `files.js:7-10`, `search.js:8-9` |
| O11 | **Silent error swallowing** — `let _ =` discards DB errors in ~20 locations; messages can fail to persist with no feedback | `db.rs` throughout |
| O12 | **Inconsistent error return types** — `Result<(), String>` vs `Option<String>` vs silent discard across DB methods | `db.rs` |
| O13 | **~15 hardcoded constants** (history limit, upload size, reconnect delay, etc.) that should be configurable | `hub.rs`, `main.rs`, `transport.js`, etc. |
| O14 | **Duplicate `tauri-bridge.js`** files with different implementations | `static/js/tauri-bridge.js`, `gathering-client/src/tauri-bridge.js` |
| O15 | **No JSON parse error handling** on incoming WebSocket messages client-side — malformed message crashes the handler | `transport.js:14` |

## Recommended Priority Order

1. **S1-S3** (critical security) — XSS, file auth, CORS
2. **S4-S6** (high security) — sessions, rate limiting, HTTP exposure
3. **S7-S11** (medium security) — authorization enforcement, input validation
4. **S12-S14** (low security) — SRI, invite codes, mutex poisoning
5. **O1-O4** (structural) — decompose hub.rs/db.rs, extract helpers
6. **O5-O15** (cleanup) — dedup, state consolidation, error handling

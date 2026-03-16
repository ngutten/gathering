/// Hub-layer integration tests.
///
/// These test the Hub through its public API (connect, authenticate,
/// handle_message, disconnect) with real in-memory SQLite databases.
/// We capture messages sent to clients via mpsc channels.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::ws::Message;
use gathering::db::Db;
use gathering::hub::Hub;
use gathering::protocol::{ClientMsg, ServerConfig, ServerMsg};
use tokio::sync::mpsc;

// ── Helpers ──────────────────────────────────────────────────────────

fn setup() -> (Hub, Arc<Db>) {
    let db = Arc::new(Db::open(Path::new(":memory:")).expect("in-memory DB"));
    // Seed default roles
    db.upsert_role("user", &[
        "send_message".into(),
        "create_channel".into(),
        "create_topic".into(),
        "upload_file".into(),
        "edit_own_message".into(),
        "delete_own_message".into(),
    ]);
    db.upsert_role("admin", &["*".into()]);
    let hub = Hub::new(db.clone(), std::path::PathBuf::from("/tmp/gathering-test"), ServerConfig::default(), None);
    (hub, db)
}

/// Register a user, log in, connect to the hub, and authenticate.
/// Returns (client_id, rx) where rx receives all messages sent to this client.
async fn connect_user(hub: &Hub, db: &Db, username: &str) -> (usize, mpsc::UnboundedReceiver<Message>) {
    db.register(username, "password123").expect("register failed");
    db.assign_role(username, "user").expect("assign role failed");
    let token = db.login(username, "password123").expect("login failed");

    let (tx, rx) = mpsc::unbounded_channel();
    let id = hub.connect(tx).await;
    hub.handle_message(id, ClientMsg::Auth { token, protocol_version: None }).await;
    (id, rx)
}

/// Drain all pending messages from an rx channel (non-blocking).
fn drain_messages(rx: &mut mpsc::UnboundedReceiver<Message>) -> Vec<ServerMsg> {
    let mut msgs = Vec::new();
    while let Ok(msg) = rx.try_recv() {
        if let Message::Text(text) = msg {
            if let Ok(server_msg) = serde_json::from_str::<ServerMsg>(&text) {
                msgs.push(server_msg);
            }
        }
    }
    msgs
}

/// Find a specific message type in a list.
fn find_msg<'a>(msgs: &'a [ServerMsg], pred: impl Fn(&ServerMsg) -> bool) -> Option<&'a ServerMsg> {
    msgs.iter().find(|m| pred(m))
}

// ── Auth ─────────────────────────────────────────────────────────────

#[tokio::test]
async fn auth_success() {
    let (hub, db) = setup();
    let (id, mut rx) = connect_user(&hub, &db, "alice").await;
    let msgs = drain_messages(&mut rx);

    let auth = find_msg(&msgs, |m| matches!(m, ServerMsg::AuthResult { ok: true, .. }));
    assert!(auth.is_some(), "Expected AuthResult ok=true, got: {msgs:?}");

    if let Some(ServerMsg::AuthResult { username, .. }) = auth {
        assert_eq!(username.as_deref(), Some("alice"));
    }

    hub.disconnect(id).await;
}

#[tokio::test]
async fn auth_invalid_token() {
    let (hub, _db) = setup();
    let (tx, mut rx) = mpsc::unbounded_channel();
    let id = hub.connect(tx).await;
    hub.handle_message(id, ClientMsg::Auth { token: "bad-token".into(), protocol_version: None }).await;

    let msgs = drain_messages(&mut rx);
    let auth = find_msg(&msgs, |m| matches!(m, ServerMsg::AuthResult { ok: false, .. }));
    assert!(auth.is_some(), "Expected AuthResult ok=false");

    hub.disconnect(id).await;
}

#[tokio::test]
async fn unauthenticated_message_rejected() {
    let (hub, _db) = setup();
    let (tx, mut rx) = mpsc::unbounded_channel();
    let id = hub.connect(tx).await;

    // Try to send without authenticating
    hub.handle_message(id, ClientMsg::Send {
        channel: "general".into(),
        content: "hello".into(),
        ttl_secs: None,
        attachments: None,
        encrypted: false,
        reply_to: None,
    }).await;

    let msgs = drain_messages(&mut rx);
    let err = find_msg(&msgs, |m| matches!(m, ServerMsg::Error { .. }));
    assert!(err.is_some(), "Expected error for unauthenticated send");

    hub.disconnect(id).await;
}

// ── Channel join/leave ───────────────────────────────────────────────

#[tokio::test]
async fn auto_joins_general_on_auth() {
    let (hub, db) = setup();
    let (_id, mut rx) = connect_user(&hub, &db, "alice").await;
    let msgs = drain_messages(&mut rx);

    // Should receive channel list including general
    let channel_list = find_msg(&msgs, |m| matches!(m, ServerMsg::ChannelList { .. }));
    assert!(channel_list.is_some());
    if let Some(ServerMsg::ChannelList { channels }) = channel_list {
        assert!(channels.iter().any(|c| c.name == "general"));
    }

    // Should receive history for general
    let history = find_msg(&msgs, |m| matches!(m, ServerMsg::History { channel, .. } if channel == "general"));
    assert!(history.is_some());
}

#[tokio::test]
async fn join_creates_channel_and_sends_history() {
    let (hub, db) = setup();
    let (id, mut rx) = connect_user(&hub, &db, "alice").await;
    drain_messages(&mut rx); // clear auth messages

    hub.handle_message(id, ClientMsg::Join { channel: "new-channel".into() }).await;

    let msgs = drain_messages(&mut rx);
    let history = find_msg(&msgs, |m| matches!(m, ServerMsg::History { channel, .. } if channel == "new-channel"));
    assert!(history.is_some(), "Expected history for new-channel");
    assert!(db.channel_exists("new-channel"));
}

#[tokio::test]
async fn join_invalid_channel_name_rejected() {
    let (hub, db) = setup();
    let (id, mut rx) = connect_user(&hub, &db, "alice").await;
    drain_messages(&mut rx);

    hub.handle_message(id, ClientMsg::Join { channel: "bad channel!@#".into() }).await;

    let msgs = drain_messages(&mut rx);
    let err = find_msg(&msgs, |m| matches!(m, ServerMsg::Error { .. }));
    assert!(err.is_some(), "Expected error for invalid channel name");
}

#[tokio::test]
async fn join_restricted_channel_denied() {
    let (hub, db) = setup();
    db.ensure_channel("private");
    db.set_channel_restricted("private", true);

    let (id, mut rx) = connect_user(&hub, &db, "alice").await;
    drain_messages(&mut rx);

    hub.handle_message(id, ClientMsg::Join { channel: "private".into() }).await;

    let msgs = drain_messages(&mut rx);
    let err = find_msg(&msgs, |m| matches!(m, ServerMsg::Error { message } if message.contains("restricted")));
    assert!(err.is_some(), "Expected restricted error, got: {msgs:?}");
}

#[tokio::test]
async fn join_restricted_channel_allowed_for_member() {
    let (hub, db) = setup();
    db.ensure_channel("private");
    db.set_channel_restricted("private", true);
    // Pre-register alice before connect_user registers her
    db.register("alice", "password123").unwrap();
    db.assign_role("alice", "user").unwrap();
    db.add_channel_member("private", "alice");
    let token = db.login("alice", "password123").unwrap();

    let (tx, mut rx) = mpsc::unbounded_channel();
    let id = hub.connect(tx).await;
    hub.handle_message(id, ClientMsg::Auth { token, protocol_version: None }).await;
    drain_messages(&mut rx);

    hub.handle_message(id, ClientMsg::Join { channel: "private".into() }).await;

    let msgs = drain_messages(&mut rx);
    let history = find_msg(&msgs, |m| matches!(m, ServerMsg::History { channel, .. } if channel == "private"));
    assert!(history.is_some(), "Member should be able to join restricted channel");
}

// ── Send messages ────────────────────────────────────────────────────

#[tokio::test]
async fn send_message_broadcast_to_channel() {
    let (hub, db) = setup();
    let (alice_id, mut alice_rx) = connect_user(&hub, &db, "alice").await;
    let (bob_id, mut bob_rx) = connect_user(&hub, &db, "bob").await;
    drain_messages(&mut alice_rx);
    drain_messages(&mut bob_rx);

    // Both are auto-joined to general
    hub.handle_message(alice_id, ClientMsg::Send {
        channel: "general".into(),
        content: "hello everyone".into(),
        ttl_secs: None,
        attachments: None,
        encrypted: false,
        reply_to: None,
    }).await;

    // Alice should receive the broadcast (sender is included)
    let alice_msgs = drain_messages(&mut alice_rx);
    let alice_msg = find_msg(&alice_msgs, |m| matches!(m, ServerMsg::Message { content, .. } if content == "hello everyone"));
    assert!(alice_msg.is_some(), "Alice should receive her own message");

    // Bob should also receive it
    let bob_msgs = drain_messages(&mut bob_rx);
    let bob_msg = find_msg(&bob_msgs, |m| matches!(m, ServerMsg::Message { content, .. } if content == "hello everyone"));
    assert!(bob_msg.is_some(), "Bob should receive Alice's message");

    hub.disconnect(alice_id).await;
    hub.disconnect(bob_id).await;
}

#[tokio::test]
async fn send_to_unjoined_channel_rejected() {
    let (hub, db) = setup();
    let (id, mut rx) = connect_user(&hub, &db, "alice").await;
    drain_messages(&mut rx);

    // Alice hasn't joined "other-channel"
    hub.handle_message(id, ClientMsg::Send {
        channel: "other-channel".into(),
        content: "hello".into(),
        ttl_secs: None,
        attachments: None,
        encrypted: false,
        reply_to: None,
    }).await;

    let msgs = drain_messages(&mut rx);
    let err = find_msg(&msgs, |m| matches!(m, ServerMsg::Error { .. }));
    assert!(err.is_some(), "Should get error for sending to unjoined channel");
}

#[tokio::test]
async fn send_message_too_long_rejected() {
    let (hub, db) = setup();
    let (id, mut rx) = connect_user(&hub, &db, "alice").await;
    drain_messages(&mut rx);

    let long_content = "x".repeat(33 * 1024); // > 32KB
    hub.handle_message(id, ClientMsg::Send {
        channel: "general".into(),
        content: long_content,
        ttl_secs: None,
        attachments: None,
        encrypted: false,
        reply_to: None,
    }).await;

    let msgs = drain_messages(&mut rx);
    let err = find_msg(&msgs, |m| matches!(m, ServerMsg::Error { message } if message.contains("too long")));
    assert!(err.is_some(), "Expected message-too-long error");
}

// ── Message persistence ──────────────────────────────────────────────

#[tokio::test]
async fn sent_message_persisted_in_db() {
    let (hub, db) = setup();
    let (id, mut rx) = connect_user(&hub, &db, "alice").await;
    drain_messages(&mut rx);

    hub.handle_message(id, ClientMsg::Send {
        channel: "general".into(),
        content: "persistent message".into(),
        ttl_secs: None,
        attachments: None,
        encrypted: false,
        reply_to: None,
    }).await;

    let history = db.get_history("general", 10);
    assert!(history.iter().any(|m| m.content == "persistent message"));
}

// ── History ──────────────────────────────────────────────────────────

#[tokio::test]
async fn history_requires_channel_membership() {
    let (hub, db) = setup();
    let (id, mut rx) = connect_user(&hub, &db, "alice").await;
    drain_messages(&mut rx);

    // Request history for a channel Alice hasn't joined
    hub.handle_message(id, ClientMsg::History {
        channel: "other-channel".into(),
        limit: None,
    }).await;

    let msgs = drain_messages(&mut rx);
    let err = find_msg(&msgs, |m| matches!(m, ServerMsg::Error { .. }));
    assert!(err.is_some(), "Should get error for history of unjoined channel");
}

// ── Online users ─────────────────────────────────────────────────────

#[tokio::test]
async fn online_users_updated_on_connect_disconnect() {
    let (hub, db) = setup();
    let (alice_id, mut alice_rx) = connect_user(&hub, &db, "alice").await;

    // After alice connects, she should see herself online
    let msgs = drain_messages(&mut alice_rx);
    let online = find_msg(&msgs, |m| matches!(m, ServerMsg::OnlineUsers { .. }));
    assert!(online.is_some());
    if let Some(ServerMsg::OnlineUsers { users }) = online {
        assert!(users.contains(&"alice".to_string()));
    }

    // Connect bob
    let (bob_id, mut bob_rx) = connect_user(&hub, &db, "bob").await;
    // Alice should get an updated online users list
    // Give a tiny moment for messages to propagate
    tokio::time::sleep(Duration::from_millis(10)).await;
    let alice_msgs = drain_messages(&mut alice_rx);
    let online2 = alice_msgs.iter().rev().find(|m| matches!(m, ServerMsg::OnlineUsers { .. }));
    if let Some(ServerMsg::OnlineUsers { users }) = online2 {
        assert!(users.contains(&"alice".to_string()));
        assert!(users.contains(&"bob".to_string()));
    }

    // Disconnect bob
    hub.disconnect(bob_id).await;
    tokio::time::sleep(Duration::from_millis(10)).await;
    let alice_msgs = drain_messages(&mut alice_rx);
    let online3 = alice_msgs.iter().rev().find(|m| matches!(m, ServerMsg::OnlineUsers { .. }));
    if let Some(ServerMsg::OnlineUsers { users }) = online3 {
        assert!(users.contains(&"alice".to_string()));
        assert!(!users.contains(&"bob".to_string()));
    }

    hub.disconnect(alice_id).await;
    drain_messages(&mut bob_rx); // just drain to avoid unused warning
}

// ── Typing indicator ─────────────────────────────────────────────────

#[tokio::test]
async fn typing_indicator_broadcast() {
    let (hub, db) = setup();
    let (alice_id, mut alice_rx) = connect_user(&hub, &db, "alice").await;
    let (_bob_id, mut bob_rx) = connect_user(&hub, &db, "bob").await;
    drain_messages(&mut alice_rx);
    drain_messages(&mut bob_rx);

    hub.handle_message(alice_id, ClientMsg::Typing { channel: "general".into() }).await;

    // Bob should see Alice typing (Alice should not, since exclude=Some(alice_id))
    let bob_msgs = drain_messages(&mut bob_rx);
    let typing = find_msg(&bob_msgs, |m| matches!(m, ServerMsg::UserTyping { username, .. } if username == "alice"));
    assert!(typing.is_some(), "Bob should see Alice's typing indicator");

    let alice_msgs = drain_messages(&mut alice_rx);
    let alice_typing = find_msg(&alice_msgs, |m| matches!(m, ServerMsg::UserTyping { .. }));
    assert!(alice_typing.is_none(), "Alice should not see her own typing indicator");
}

// ── Permission checks ────────────────────────────────────────────────

#[tokio::test]
async fn send_without_permission_rejected() {
    let (hub, db) = setup();
    // Create a user with no send_message permission
    db.register("muted", "password123").unwrap();
    db.upsert_role("muted_role", &["create_channel".into()]);
    db.assign_role("muted", "muted_role").unwrap();
    let token = db.login("muted", "password123").unwrap();

    let (tx, mut rx) = mpsc::unbounded_channel();
    let id = hub.connect(tx).await;
    hub.handle_message(id, ClientMsg::Auth { token, protocol_version: None }).await;
    drain_messages(&mut rx);

    hub.handle_message(id, ClientMsg::Send {
        channel: "general".into(),
        content: "should fail".into(),
        ttl_secs: None,
        attachments: None,
        encrypted: false,
        reply_to: None,
    }).await;

    let msgs = drain_messages(&mut rx);
    let err = find_msg(&msgs, |m| matches!(m, ServerMsg::Error { message } if message.contains("send_message")));
    assert!(err.is_some(), "Expected permission denied error, got: {msgs:?}");
}

// ── Disconnect cleanup ───────────────────────────────────────────────

#[tokio::test]
async fn disconnect_broadcasts_user_left() {
    let (hub, db) = setup();
    let (alice_id, mut alice_rx) = connect_user(&hub, &db, "alice").await;
    let (bob_id, mut bob_rx) = connect_user(&hub, &db, "bob").await;
    drain_messages(&mut alice_rx);
    drain_messages(&mut bob_rx);

    hub.disconnect(bob_id).await;
    tokio::time::sleep(Duration::from_millis(10)).await;

    let alice_msgs = drain_messages(&mut alice_rx);
    let left = find_msg(&alice_msgs, |m| matches!(m, ServerMsg::UserLeft { username, .. } if username == "bob"));
    assert!(left.is_some(), "Alice should see Bob left, got: {alice_msgs:?}");

    hub.disconnect(alice_id).await;
}

// ── Leave channel ────────────────────────────────────────────────────

#[tokio::test]
async fn leave_channel_broadcasts() {
    let (hub, db) = setup();
    let (alice_id, mut alice_rx) = connect_user(&hub, &db, "alice").await;
    let (_bob_id, mut bob_rx) = connect_user(&hub, &db, "bob").await;
    drain_messages(&mut alice_rx);
    drain_messages(&mut bob_rx);

    hub.handle_message(alice_id, ClientMsg::Leave { channel: "general".into() }).await;

    let bob_msgs = drain_messages(&mut bob_rx);
    let left = find_msg(&bob_msgs, |m| matches!(m, ServerMsg::UserLeft { channel, username } if channel == "general" && username == "alice"));
    assert!(left.is_some(), "Bob should see Alice left general");
}

// ── Reactions ────────────────────────────────────────────────────────

#[tokio::test]
async fn add_reaction_broadcast() {
    let (hub, db) = setup();
    let (alice_id, mut alice_rx) = connect_user(&hub, &db, "alice").await;
    let (_bob_id, mut bob_rx) = connect_user(&hub, &db, "bob").await;
    drain_messages(&mut alice_rx);
    drain_messages(&mut bob_rx);

    // Alice sends a message
    hub.handle_message(alice_id, ClientMsg::Send {
        channel: "general".into(),
        content: "react to this".into(),
        ttl_secs: None,
        attachments: None,
        encrypted: false,
        reply_to: None,
    }).await;

    let alice_msgs = drain_messages(&mut alice_rx);
    let msg = find_msg(&alice_msgs, |m| matches!(m, ServerMsg::Message { content, .. } if content == "react to this"));
    let msg_id = if let Some(ServerMsg::Message { id, .. }) = msg { id.clone() } else { panic!("no message") };
    drain_messages(&mut bob_rx);

    // Bob reacts
    hub.handle_message(_bob_id, ClientMsg::AddReaction { message_id: msg_id.clone(), emoji: "👍".into() }).await;

    let bob_msgs = drain_messages(&mut bob_rx);
    let reaction = find_msg(&bob_msgs, |m| matches!(m, ServerMsg::ReactionUpdated { added: true, emoji, username, .. } if emoji == "👍" && username == "bob"));
    assert!(reaction.is_some(), "Bob should see reaction broadcast");

    let alice_msgs = drain_messages(&mut alice_rx);
    let alice_reaction = find_msg(&alice_msgs, |m| matches!(m, ServerMsg::ReactionUpdated { added: true, .. }));
    assert!(alice_reaction.is_some(), "Alice should see reaction broadcast");
}

#[tokio::test]
async fn remove_reaction_broadcast() {
    let (hub, db) = setup();
    let (alice_id, mut alice_rx) = connect_user(&hub, &db, "alice").await;
    drain_messages(&mut alice_rx);

    // Send message and add reaction
    hub.handle_message(alice_id, ClientMsg::Send {
        channel: "general".into(),
        content: "test".into(),
        ttl_secs: None, attachments: None, encrypted: false, reply_to: None,
    }).await;
    let msgs = drain_messages(&mut alice_rx);
    let msg_id = if let Some(ServerMsg::Message { id, .. }) = find_msg(&msgs, |m| matches!(m, ServerMsg::Message { .. })) { id.clone() } else { panic!("no message") };

    hub.handle_message(alice_id, ClientMsg::AddReaction { message_id: msg_id.clone(), emoji: "👍".into() }).await;
    drain_messages(&mut alice_rx);

    // Remove reaction
    hub.handle_message(alice_id, ClientMsg::RemoveReaction { message_id: msg_id.clone(), emoji: "👍".into() }).await;
    let msgs = drain_messages(&mut alice_rx);
    let removed = find_msg(&msgs, |m| matches!(m, ServerMsg::ReactionUpdated { added: false, emoji, .. } if emoji == "👍"));
    assert!(removed.is_some(), "Should see reaction removed broadcast");
}

#[tokio::test]
async fn reactions_included_in_history() {
    let (hub, db) = setup();
    let (alice_id, mut alice_rx) = connect_user(&hub, &db, "alice").await;
    drain_messages(&mut alice_rx);

    // Send message
    hub.handle_message(alice_id, ClientMsg::Send {
        channel: "general".into(),
        content: "has reactions".into(),
        ttl_secs: None, attachments: None, encrypted: false, reply_to: None,
    }).await;
    let msgs = drain_messages(&mut alice_rx);
    let msg_id = if let Some(ServerMsg::Message { id, .. }) = find_msg(&msgs, |m| matches!(m, ServerMsg::Message { .. })) { id.clone() } else { panic!("no message") };

    // Add reaction
    hub.handle_message(alice_id, ClientMsg::AddReaction { message_id: msg_id.clone(), emoji: "🎉".into() }).await;
    drain_messages(&mut alice_rx);

    // Request history
    hub.handle_message(alice_id, ClientMsg::History { channel: "general".into(), limit: None }).await;
    let msgs = drain_messages(&mut alice_rx);
    let history = find_msg(&msgs, |m| matches!(m, ServerMsg::History { .. }));
    if let Some(ServerMsg::History { messages, .. }) = history {
        let msg = messages.iter().find(|m| m.id == msg_id).expect("message should be in history");
        let reactions = msg.reactions.as_ref().expect("reactions should be present");
        assert!(reactions.contains_key("🎉"));
        assert!(reactions.get("🎉").unwrap().contains(&"alice".to_string()));
    } else {
        panic!("Expected History response");
    }
}

#[tokio::test]
async fn react_to_unjoined_channel_rejected() {
    let (hub, db) = setup();
    let (alice_id, mut alice_rx) = connect_user(&hub, &db, "alice").await;
    drain_messages(&mut alice_rx);

    // Store a message in a different channel directly in DB
    db.ensure_channel("other");
    let ts = chrono::Utc::now();
    db.store_message("other-msg", "other", "alice", "test", &ts, None, None, false, None, None);

    // Try to react without joining that channel
    hub.handle_message(alice_id, ClientMsg::AddReaction { message_id: "other-msg".into(), emoji: "👍".into() }).await;
    let msgs = drain_messages(&mut alice_rx);
    let err = find_msg(&msgs, |m| matches!(m, ServerMsg::Error { .. }));
    assert!(err.is_some(), "Should get error for reacting to unjoined channel message");
}

// ── Message Pinning ──────────────────────────────────────────────────

#[tokio::test]
async fn pin_message_by_admin() {
    let (hub, db) = setup();
    // Create admin user
    db.register("admin", "password123").unwrap();
    db.upsert_role("admin", &["*".into()]);
    db.assign_role("admin", "admin").unwrap();
    let token = db.login("admin", "password123").unwrap();

    let (tx, mut rx) = mpsc::unbounded_channel();
    let admin_id = hub.connect(tx).await;
    hub.handle_message(admin_id, ClientMsg::Auth { token, protocol_version: None }).await;
    drain_messages(&mut rx);

    // Send a message
    hub.handle_message(admin_id, ClientMsg::Send {
        channel: "general".into(),
        content: "pin me".into(),
        ttl_secs: None, attachments: None, encrypted: false, reply_to: None,
    }).await;
    let msgs = drain_messages(&mut rx);
    let msg_id = if let Some(ServerMsg::Message { id, .. }) = find_msg(&msgs, |m| matches!(m, ServerMsg::Message { .. })) { id.clone() } else { panic!("no message") };

    // Pin it
    hub.handle_message(admin_id, ClientMsg::PinMessage { message_id: msg_id.clone(), pinned: true }).await;
    let msgs = drain_messages(&mut rx);
    let pinned = find_msg(&msgs, |m| matches!(m, ServerMsg::MessagePinned { pinned: true, .. }));
    assert!(pinned.is_some(), "Should see MessagePinned broadcast");
}

#[tokio::test]
async fn pin_message_by_non_admin_rejected() {
    let (hub, db) = setup();
    let (alice_id, mut alice_rx) = connect_user(&hub, &db, "alice").await;
    drain_messages(&mut alice_rx);

    // Send a message
    hub.handle_message(alice_id, ClientMsg::Send {
        channel: "general".into(),
        content: "try pin".into(),
        ttl_secs: None, attachments: None, encrypted: false, reply_to: None,
    }).await;
    let msgs = drain_messages(&mut alice_rx);
    let msg_id = if let Some(ServerMsg::Message { id, .. }) = find_msg(&msgs, |m| matches!(m, ServerMsg::Message { .. })) { id.clone() } else { panic!("no message") };

    // Try to pin (should fail — alice is not admin and not channel creator)
    hub.handle_message(alice_id, ClientMsg::PinMessage { message_id: msg_id.clone(), pinned: true }).await;
    let msgs = drain_messages(&mut alice_rx);
    let err = find_msg(&msgs, |m| matches!(m, ServerMsg::Error { message } if message.contains("Permission denied")));
    assert!(err.is_some(), "Non-admin should get permission denied, got: {msgs:?}");
}

#[tokio::test]
async fn pin_message_by_channel_creator() {
    let (hub, db) = setup();
    let (alice_id, mut alice_rx) = connect_user(&hub, &db, "alice").await;
    drain_messages(&mut alice_rx);

    // Alice creates a channel (by joining it)
    hub.handle_message(alice_id, ClientMsg::Join { channel: "alice-chan".into() }).await;
    drain_messages(&mut alice_rx);

    // Send a message
    hub.handle_message(alice_id, ClientMsg::Send {
        channel: "alice-chan".into(),
        content: "pin this".into(),
        ttl_secs: None, attachments: None, encrypted: false, reply_to: None,
    }).await;
    let msgs = drain_messages(&mut alice_rx);
    let msg_id = if let Some(ServerMsg::Message { id, .. }) = find_msg(&msgs, |m| matches!(m, ServerMsg::Message { .. })) { id.clone() } else { panic!("no message") };

    // Pin it (should succeed — alice is channel creator)
    hub.handle_message(alice_id, ClientMsg::PinMessage { message_id: msg_id.clone(), pinned: true }).await;
    let msgs = drain_messages(&mut alice_rx);
    let pinned = find_msg(&msgs, |m| matches!(m, ServerMsg::MessagePinned { pinned: true, .. }));
    assert!(pinned.is_some(), "Channel creator should be able to pin");
}

#[tokio::test]
async fn get_pinned_messages_via_hub() {
    let (hub, db) = setup();
    // Create admin
    db.register("admin", "password123").unwrap();
    db.upsert_role("admin", &["*".into()]);
    db.assign_role("admin", "admin").unwrap();
    let token = db.login("admin", "password123").unwrap();

    let (tx, mut rx) = mpsc::unbounded_channel();
    let admin_id = hub.connect(tx).await;
    hub.handle_message(admin_id, ClientMsg::Auth { token, protocol_version: None }).await;
    drain_messages(&mut rx);

    // Send and pin a message
    hub.handle_message(admin_id, ClientMsg::Send {
        channel: "general".into(),
        content: "pinned msg".into(),
        ttl_secs: None, attachments: None, encrypted: false, reply_to: None,
    }).await;
    let msgs = drain_messages(&mut rx);
    let msg_id = if let Some(ServerMsg::Message { id, .. }) = find_msg(&msgs, |m| matches!(m, ServerMsg::Message { .. })) { id.clone() } else { panic!("no message") };

    hub.handle_message(admin_id, ClientMsg::PinMessage { message_id: msg_id.clone(), pinned: true }).await;
    drain_messages(&mut rx);

    // Get pinned messages
    hub.handle_message(admin_id, ClientMsg::GetPinnedMessages { channel: "general".into() }).await;
    let msgs = drain_messages(&mut rx);
    let pinned = find_msg(&msgs, |m| matches!(m, ServerMsg::PinnedMessages { .. }));
    if let Some(ServerMsg::PinnedMessages { messages, .. }) = pinned {
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].id, msg_id);
        assert!(messages[0].pinned);
    } else {
        panic!("Expected PinnedMessages response, got: {msgs:?}");
    }
}

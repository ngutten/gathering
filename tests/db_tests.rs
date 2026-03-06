/// Database-layer tests using in-memory SQLite.
///
/// These test the Db API directly — auth, channels, messages, roles,
/// access control, invites, DMs, settings, and members.

use std::path::Path;

use gathering::db::Db;

// ── Helpers ──────────────────────────────────────────────────────────

fn fresh_db() -> Db {
    Db::open(Path::new(":memory:")).expect("in-memory DB should open")
}

fn register_and_login(db: &Db, user: &str, pass: &str) -> String {
    db.register(user, pass).expect("register should succeed");
    db.login(user, pass).expect("login should succeed")
}

// ── Auth ─────────────────────────────────────────────────────────────

#[test]
fn register_and_login_roundtrip() {
    let db = fresh_db();
    db.register("alice", "password123").unwrap();
    let token = db.login("alice", "password123").unwrap();
    assert!(!token.is_empty());
    assert_eq!(db.validate_token(&token), Some("alice".into()));
}

#[test]
fn register_duplicate_username_fails() {
    let db = fresh_db();
    db.register("alice", "pass123456").unwrap();
    let err = db.register("alice", "other12345").unwrap_err();
    assert!(err.contains("already taken"), "got: {err}");
}

#[test]
fn login_wrong_password_fails() {
    let db = fresh_db();
    db.register("alice", "password123").unwrap();
    let err = db.login("alice", "wrongpassword").unwrap_err();
    assert!(err.contains("Invalid password"), "got: {err}");
}

#[test]
fn login_nonexistent_user_fails() {
    let db = fresh_db();
    let err = db.login("nobody", "password123").unwrap_err();
    assert!(err.contains("not found"), "got: {err}");
}

#[test]
fn validate_token_invalid() {
    let db = fresh_db();
    assert_eq!(db.validate_token("nonexistent-token"), None);
}

#[test]
fn delete_session_invalidates_token() {
    let db = fresh_db();
    let token = register_and_login(&db, "alice", "password123");
    assert!(db.validate_token(&token).is_some());
    db.delete_session(&token);
    assert_eq!(db.validate_token(&token), None);
}

#[test]
fn user_exists_check() {
    let db = fresh_db();
    assert!(!db.user_exists("alice"));
    db.register("alice", "password123").unwrap();
    assert!(db.user_exists("alice"));
    assert!(!db.user_exists("bob"));
}

// ── Channels ─────────────────────────────────────────────────────────

#[test]
fn general_channel_exists_by_default() {
    let db = fresh_db();
    assert!(db.channel_exists("general"));
}

#[test]
fn ensure_channel_creates_and_is_idempotent() {
    let db = fresh_db();
    assert!(!db.channel_exists("test"));
    db.ensure_channel("test");
    assert!(db.channel_exists("test"));
    db.ensure_channel("test"); // should not panic
    assert!(db.channel_exists("test"));
}

#[test]
fn ensure_channel_with_creator() {
    let db = fresh_db();
    db.register("alice", "password123").unwrap();
    db.ensure_channel_with_creator("dev", "alice");
    assert!(db.channel_exists("dev"));
    assert_eq!(db.get_channel_creator("dev"), Some("alice".into()));
}

#[test]
fn delete_channel_removes_it() {
    let db = fresh_db();
    db.ensure_channel("temp");
    assert!(db.channel_exists("temp"));
    db.delete_channel("temp").unwrap();
    assert!(!db.channel_exists("temp"));
}

#[test]
fn delete_general_channel_fails() {
    let db = fresh_db();
    let err = db.delete_channel("general").unwrap_err();
    assert!(err.contains("general"), "got: {err}");
}

#[test]
fn delete_nonexistent_channel_fails() {
    let db = fresh_db();
    let err = db.delete_channel("nonexistent").unwrap_err();
    assert!(err.contains("not found"), "got: {err}");
}

#[test]
fn list_channels_includes_created() {
    let db = fresh_db();
    db.ensure_channel("alpha");
    db.ensure_channel("beta");
    let channels = db.list_channels_with_type();
    let names: Vec<&str> = channels.iter().map(|(n, _)| n.as_str()).collect();
    assert!(names.contains(&"general"));
    assert!(names.contains(&"alpha"));
    assert!(names.contains(&"beta"));
}

#[test]
fn create_channel_with_type_voice() {
    let db = fresh_db();
    db.create_channel_with_type("voice-lobby", "voice");
    let channels = db.list_channels_with_type();
    let voice = channels.iter().find(|(n, _)| n == "voice-lobby");
    assert!(voice.is_some());
    assert_eq!(voice.unwrap().1, "voice");
}

// ── Channel Restriction & Access Control ─────────────────────────────

#[test]
fn channel_not_restricted_by_default() {
    let db = fresh_db();
    db.ensure_channel("open-chan");
    assert!(!db.is_channel_restricted("open-chan"));
}

#[test]
fn set_channel_restricted() {
    let db = fresh_db();
    db.register("alice", "password123").unwrap();
    db.ensure_channel("secret");
    db.set_channel_restricted("secret", true);
    assert!(db.is_channel_restricted("secret"));

    // Unrestrict
    db.set_channel_restricted("secret", false);
    assert!(!db.is_channel_restricted("secret"));
}

#[test]
fn can_access_open_channel() {
    let db = fresh_db();
    db.register("alice", "password123").unwrap();
    db.ensure_channel("open-chan");
    assert!(db.can_access_channel("open-chan", "alice"));
}

#[test]
fn restricted_channel_denies_non_member() {
    let db = fresh_db();
    db.register("alice", "password123").unwrap();
    db.register("bob", "password123").unwrap();
    db.ensure_channel("private");
    db.set_channel_restricted("private", true);
    db.add_channel_member("private", "alice");

    assert!(db.can_access_channel("private", "alice"));
    assert!(!db.can_access_channel("private", "bob"));
}

#[test]
fn dm_channel_access() {
    let db = fresh_db();
    db.register("alice", "password123").unwrap();
    db.register("bob", "password123").unwrap();
    db.ensure_channel("dm:alice:bob");
    db.add_dm_member("dm:alice:bob", "alice");
    db.add_dm_member("dm:alice:bob", "bob");

    assert!(db.can_access_channel("dm:alice:bob", "alice"));
    assert!(db.can_access_channel("dm:alice:bob", "bob"));
    assert!(!db.can_access_channel("dm:alice:bob", "charlie"));
}

#[test]
fn is_dm_channel_detection() {
    assert!(Db::is_dm_channel("dm:alice:bob"));
    assert!(!Db::is_dm_channel("general"));
    assert!(!Db::is_dm_channel("dm-like"));
}

// ── Channel Members ──────────────────────────────────────────────────

#[test]
fn add_and_list_channel_members() {
    let db = fresh_db();
    db.register("alice", "password123").unwrap();
    db.register("bob", "password123").unwrap();
    db.ensure_channel("team");
    db.add_channel_member("team", "alice");
    db.add_channel_member("team", "bob");

    let members = db.get_channel_members("team");
    assert_eq!(members, vec!["alice", "bob"]);
}

#[test]
fn remove_channel_member() {
    let db = fresh_db();
    db.register("alice", "password123").unwrap();
    db.register("bob", "password123").unwrap();
    db.ensure_channel("team");
    db.add_channel_member("team", "alice");
    db.add_channel_member("team", "bob");
    db.remove_channel_member("team", "bob");

    let members = db.get_channel_members("team");
    assert_eq!(members, vec!["alice"]);
}

#[test]
fn add_channel_member_idempotent() {
    let db = fresh_db();
    db.register("alice", "password123").unwrap();
    db.ensure_channel("team");
    db.add_channel_member("team", "alice");
    db.add_channel_member("team", "alice"); // should not panic or duplicate
    let members = db.get_channel_members("team");
    assert_eq!(members, vec!["alice"]);
}

// ── Messages ─────────────────────────────────────────────────────────

#[test]
fn store_and_retrieve_message() {
    let db = fresh_db();
    db.register("alice", "password123").unwrap();
    let ts = chrono::Utc::now();

    db.store_message("msg-1", "general", "alice", "hello world", &ts, None, None, false, None, None);

    let history = db.get_history("general", 10);
    assert_eq!(history.len(), 1);
    assert_eq!(history[0].id, "msg-1");
    assert_eq!(history[0].author, "alice");
    assert_eq!(history[0].content, "hello world");
    assert!(!history[0].encrypted);
}

#[test]
fn message_history_ordering() {
    let db = fresh_db();
    db.register("alice", "password123").unwrap();

    let base = chrono::Utc::now();
    for i in 0..5 {
        let ts = base + chrono::Duration::seconds(i);
        db.store_message(&format!("msg-{i}"), "general", "alice", &format!("message {i}"), &ts, None, None, false, None, None);
    }

    let history = db.get_history("general", 10);
    assert_eq!(history.len(), 5);
    // Should be in chronological order (oldest first)
    assert_eq!(history[0].content, "message 0");
    assert_eq!(history[4].content, "message 4");
}

#[test]
fn message_history_limit() {
    let db = fresh_db();
    db.register("alice", "password123").unwrap();
    let base = chrono::Utc::now();

    for i in 0..10 {
        let ts = base + chrono::Duration::seconds(i);
        db.store_message(&format!("msg-{i}"), "general", "alice", &format!("msg {i}"), &ts, None, None, false, None, None);
    }

    let history = db.get_history("general", 3);
    assert_eq!(history.len(), 3);
    // Should return the 3 most recent messages
    assert_eq!(history[0].content, "msg 7");
    assert_eq!(history[2].content, "msg 9");
}

#[test]
fn expired_messages_excluded_from_history() {
    let db = fresh_db();
    db.register("alice", "password123").unwrap();
    let now = chrono::Utc::now();
    let past = now - chrono::Duration::hours(1);

    // Store one permanent and one expired message
    db.store_message("perm", "general", "alice", "permanent", &now, None, None, false, None, None);
    db.store_message("expired", "general", "alice", "gone", &(now - chrono::Duration::hours(2)), Some(&past), None, false, None, None);

    let history = db.get_history("general", 10);
    assert_eq!(history.len(), 1);
    assert_eq!(history[0].id, "perm");
}

#[test]
fn message_with_reply_to() {
    let db = fresh_db();
    db.register("alice", "password123").unwrap();
    db.register("bob", "password123").unwrap();
    let ts = chrono::Utc::now();

    db.store_message("msg-1", "general", "alice", "original message", &ts, None, None, false, None, None);

    let reply_ref = gathering::protocol::ReplyRef {
        message_id: "msg-1".into(),
        author: "alice".into(),
        snippet: "original message".into(),
    };
    let ts2 = ts + chrono::Duration::seconds(1);
    db.store_message("msg-2", "general", "bob", "reply here", &ts2, None, None, false, Some(&reply_ref), None);

    let history = db.get_history("general", 10);
    assert_eq!(history.len(), 2);
    let reply = &history[1];
    assert!(reply.reply_to.is_some());
    let rt = reply.reply_to.as_ref().unwrap();
    assert_eq!(rt.message_id, "msg-1");
    assert_eq!(rt.author, "alice");
    assert_eq!(rt.snippet, "original message");
}

#[test]
fn edit_message() {
    let db = fresh_db();
    db.register("alice", "password123").unwrap();
    let ts = chrono::Utc::now();
    db.store_message("msg-1", "general", "alice", "original", &ts, None, None, false, None, None);

    let (channel, author) = db.edit_message("msg-1", "edited content").unwrap();
    assert_eq!(channel, "general");
    assert_eq!(author, "alice");

    let history = db.get_history("general", 10);
    assert_eq!(history[0].content, "edited content");
    assert!(history[0].edited_at.is_some());
}

#[test]
fn delete_message() {
    let db = fresh_db();
    db.register("alice", "password123").unwrap();
    let ts = chrono::Utc::now();
    db.store_message("msg-1", "general", "alice", "to delete", &ts, None, None, false, None, None);

    let (channel, author) = db.delete_message("msg-1").unwrap();
    assert_eq!(channel, "general");
    assert_eq!(author, "alice");

    let history = db.get_history("general", 10);
    assert!(history.is_empty());
}

#[test]
fn get_message_info() {
    let db = fresh_db();
    db.register("alice", "password123").unwrap();
    let ts = chrono::Utc::now();
    db.store_message("msg-1", "general", "alice", "hello", &ts, None, None, false, None, None);

    let info = db.get_message_info("msg-1");
    assert!(info.is_some());
    let (channel, author) = info.unwrap();
    assert_eq!(channel, "general");
    assert_eq!(author, "alice");

    assert!(db.get_message_info("nonexistent").is_none());
}

#[test]
fn message_with_mentions() {
    let db = fresh_db();
    db.register("alice", "password123").unwrap();
    db.register("bob", "password123").unwrap();
    let ts = chrono::Utc::now();
    let mentions = vec!["bob".to_string()];
    db.store_message("msg-1", "general", "alice", "hey @bob", &ts, None, None, false, None, Some(&mentions));

    let history = db.get_history("general", 10);
    assert_eq!(history.len(), 1);
    assert_eq!(history[0].mentions.as_ref().unwrap(), &vec!["bob".to_string()]);
}

// ── Purge Expired ────────────────────────────────────────────────────

#[test]
fn purge_expired_messages() {
    let db = fresh_db();
    db.register("alice", "password123").unwrap();
    let now = chrono::Utc::now();
    let past = now - chrono::Duration::hours(1);

    db.store_message("keep", "general", "alice", "permanent", &now, None, None, false, None, None);
    db.store_message("expire", "general", "alice", "temporary", &(now - chrono::Duration::hours(2)), Some(&past), None, false, None, None);

    let purged = db.purge_expired();
    assert!(purged >= 1);

    let history = db.get_history("general", 10);
    assert_eq!(history.len(), 1);
    assert_eq!(history[0].id, "keep");
}

// ── Roles & Permissions ──────────────────────────────────────────────

#[test]
fn upsert_and_list_roles() {
    let db = fresh_db();
    db.upsert_role("moderator", &["delete_message".into(), "pin_topic".into()]);

    let roles = db.list_roles();
    let mod_role = roles.iter().find(|r| r.name == "moderator");
    assert!(mod_role.is_some());
    let perms = &mod_role.unwrap().permissions;
    assert!(perms.contains(&"delete_message".to_string()));
    assert!(perms.contains(&"pin_topic".to_string()));
}

#[test]
fn delete_builtin_role_fails() {
    let db = fresh_db();
    db.upsert_role("user", &["send_message".into()]);
    db.upsert_role("admin", &["*".into()]);
    assert!(db.delete_role("user").is_err());
    assert!(db.delete_role("admin").is_err());
}

#[test]
fn delete_custom_role() {
    let db = fresh_db();
    db.upsert_role("temp", &["send_message".into()]);
    db.delete_role("temp").unwrap();
    let roles = db.list_roles();
    assert!(!roles.iter().any(|r| r.name == "temp"));
}

#[test]
fn assign_and_get_user_roles() {
    let db = fresh_db();
    db.register("alice", "password123").unwrap();
    db.upsert_role("user", &["send_message".into()]);
    db.upsert_role("moderator", &["delete_message".into()]);
    db.assign_role("alice", "user").unwrap();
    db.assign_role("alice", "moderator").unwrap();

    let roles = db.get_user_roles("alice");
    assert!(roles.contains(&"user".to_string()));
    assert!(roles.contains(&"moderator".to_string()));
}

#[test]
fn remove_user_role() {
    let db = fresh_db();
    db.register("alice", "password123").unwrap();
    db.upsert_role("user", &["send_message".into()]);
    db.assign_role("alice", "user").unwrap();
    db.remove_role("alice", "user").unwrap();

    let roles = db.get_user_roles("alice");
    assert!(!roles.contains(&"user".to_string()));
}

#[test]
fn user_has_permission_direct() {
    let db = fresh_db();
    db.register("alice", "password123").unwrap();
    db.upsert_role("user", &["send_message".into(), "upload_file".into()]);
    db.assign_role("alice", "user").unwrap();

    assert!(db.user_has_permission("alice", "send_message"));
    assert!(db.user_has_permission("alice", "upload_file"));
    assert!(!db.user_has_permission("alice", "delete_channel"));
}

#[test]
fn admin_wildcard_permission() {
    let db = fresh_db();
    db.register("admin_user", "password123").unwrap();
    db.upsert_role("admin", &["*".into()]);
    db.assign_role("admin_user", "admin").unwrap();

    assert!(db.user_has_permission("admin_user", "anything_at_all"));
    assert!(db.user_has_permission("admin_user", "delete_channel"));
}

#[test]
fn user_permissions_merged_across_roles() {
    let db = fresh_db();
    db.register("alice", "password123").unwrap();
    db.upsert_role("role_a", &["perm_1".into(), "perm_2".into()]);
    db.upsert_role("role_b", &["perm_2".into(), "perm_3".into()]);
    db.assign_role("alice", "role_a").unwrap();
    db.assign_role("alice", "role_b").unwrap();

    let perms = db.get_user_permissions("alice");
    assert!(perms.contains(&"perm_1".to_string()));
    assert!(perms.contains(&"perm_2".to_string()));
    assert!(perms.contains(&"perm_3".to_string()));
    // Deduplication check
    assert_eq!(perms.iter().filter(|p| *p == "perm_2").count(), 1);
}

// ── Settings ─────────────────────────────────────────────────────────

#[test]
fn default_settings() {
    let db = fresh_db();
    assert_eq!(db.get_setting("registration_mode"), Some("open".into()));
    assert_eq!(db.get_setting("channel_creation"), Some("all".into()));
}

#[test]
fn set_and_get_setting() {
    let db = fresh_db();
    db.set_setting("registration_mode", "invite").unwrap();
    assert_eq!(db.get_setting("registration_mode"), Some("invite".into()));
}

#[test]
fn get_all_settings() {
    let db = fresh_db();
    db.set_setting("custom_key", "custom_value").unwrap();
    let settings = db.get_settings();
    assert_eq!(settings.get("custom_key"), Some(&"custom_value".to_string()));
    assert!(settings.contains_key("registration_mode"));
}

// ── Invites ──────────────────────────────────────────────────────────

#[test]
fn create_and_validate_invite() {
    let db = fresh_db();
    let code = db.create_invite("admin");
    assert!(!code.is_empty());
    db.validate_invite(&code).expect("fresh invite should be valid");
}

#[test]
fn use_invite_consumes_it() {
    let db = fresh_db();
    let code = db.create_invite("admin");
    db.use_invite(&code, "alice").expect("use_invite should succeed");
    let err = db.validate_invite(&code).unwrap_err();
    assert!(err.contains("already used"), "got: {err}");
}

#[test]
fn use_invite_twice_fails() {
    let db = fresh_db();
    let code = db.create_invite("admin");
    db.use_invite(&code, "alice").unwrap();
    let err = db.use_invite(&code, "bob").unwrap_err();
    assert!(err.contains("already used") || err.contains("invalid"), "got: {err}");
}

#[test]
fn validate_invalid_invite_fails() {
    let db = fresh_db();
    let err = db.validate_invite("nonexistent-code").unwrap_err();
    assert!(err.contains("Invalid") || err.contains("invalid"), "got: {err}");
}

#[test]
fn list_invites_includes_created() {
    let db = fresh_db();
    let code = db.create_invite("admin");
    let invites = db.list_invites();
    assert!(invites.iter().any(|i| i.code == code));
    assert_eq!(invites.iter().find(|i| i.code == code).unwrap().created_by, "admin");
}

// ── DMs ──────────────────────────────────────────────────────────────

#[test]
fn dm_member_management() {
    let db = fresh_db();
    db.register("alice", "password123").unwrap();
    db.register("bob", "password123").unwrap();

    let channel = "dm:alice:bob";
    db.ensure_channel(channel);
    db.add_dm_member(channel, "alice");
    db.add_dm_member(channel, "bob");

    assert!(db.is_dm_member(channel, "alice"));
    assert!(db.is_dm_member(channel, "bob"));
    assert!(!db.is_dm_member(channel, "charlie"));
}

#[test]
fn list_user_dms() {
    let db = fresh_db();
    db.register("alice", "password123").unwrap();
    db.register("bob", "password123").unwrap();

    let channel = "dm:alice:bob";
    db.ensure_channel(channel);
    db.add_dm_member(channel, "alice");
    db.add_dm_member(channel, "bob");

    let alice_dms = db.list_user_dms("alice");
    assert_eq!(alice_dms.len(), 1);
    assert_eq!(alice_dms[0].channel, "dm:alice:bob");
    assert_eq!(alice_dms[0].other_user, "bob");

    let bob_dms = db.list_user_dms("bob");
    assert_eq!(bob_dms.len(), 1);
    assert_eq!(bob_dms[0].other_user, "alice");
}

// ── Delete channel cascades ──────────────────────────────────────────

#[test]
fn delete_channel_cascades_messages_and_members() {
    let db = fresh_db();
    db.register("alice", "password123").unwrap();
    db.ensure_channel("temp");
    db.add_channel_member("temp", "alice");
    let ts = chrono::Utc::now();
    db.store_message("m1", "temp", "alice", "hello", &ts, None, None, false, None, None);

    db.delete_channel("temp").unwrap();
    assert!(!db.channel_exists("temp"));
    assert!(db.get_channel_members("temp").is_empty());
    assert!(db.get_history("temp", 10).is_empty());
}

// ── Reactions ────────────────────────────────────────────────────────

#[test]
fn add_and_get_reactions() {
    let db = fresh_db();
    db.register("alice", "password123").unwrap();
    db.register("bob", "password123").unwrap();
    let ts = chrono::Utc::now();
    db.store_message("msg-1", "general", "alice", "hello", &ts, None, None, false, None, None);

    db.add_reaction("msg-1", "alice", "👍").unwrap();
    db.add_reaction("msg-1", "bob", "👍").unwrap();
    db.add_reaction("msg-1", "alice", "❤️").unwrap();

    let reactions = db.get_reactions_batch(&["msg-1".into()]);
    let msg_reactions = reactions.get("msg-1").unwrap();
    assert_eq!(msg_reactions.get("👍").unwrap().len(), 2);
    assert_eq!(msg_reactions.get("❤️").unwrap().len(), 1);
}

#[test]
fn remove_reaction() {
    let db = fresh_db();
    db.register("alice", "password123").unwrap();
    let ts = chrono::Utc::now();
    db.store_message("msg-1", "general", "alice", "hello", &ts, None, None, false, None, None);

    db.add_reaction("msg-1", "alice", "👍").unwrap();
    db.remove_reaction("msg-1", "alice", "👍").unwrap();

    let reactions = db.get_reactions_batch(&["msg-1".into()]);
    assert!(reactions.get("msg-1").is_none() || reactions.get("msg-1").unwrap().is_empty());
}

#[test]
fn add_reaction_idempotent() {
    let db = fresh_db();
    db.register("alice", "password123").unwrap();
    let ts = chrono::Utc::now();
    db.store_message("msg-1", "general", "alice", "hello", &ts, None, None, false, None, None);

    db.add_reaction("msg-1", "alice", "👍").unwrap();
    db.add_reaction("msg-1", "alice", "👍").unwrap(); // should not duplicate
    let reactions = db.get_reactions_batch(&["msg-1".into()]);
    assert_eq!(reactions.get("msg-1").unwrap().get("👍").unwrap().len(), 1);
}

#[test]
fn reactions_batch_multiple_messages() {
    let db = fresh_db();
    db.register("alice", "password123").unwrap();
    let ts = chrono::Utc::now();
    db.store_message("msg-1", "general", "alice", "first", &ts, None, None, false, None, None);
    db.store_message("msg-2", "general", "alice", "second", &ts, None, None, false, None, None);

    db.add_reaction("msg-1", "alice", "👍").unwrap();
    db.add_reaction("msg-2", "alice", "🎉").unwrap();

    let reactions = db.get_reactions_batch(&["msg-1".into(), "msg-2".into()]);
    assert!(reactions.get("msg-1").unwrap().contains_key("👍"));
    assert!(reactions.get("msg-2").unwrap().contains_key("🎉"));
}

#[test]
fn delete_message_cascades_reactions() {
    let db = fresh_db();
    db.register("alice", "password123").unwrap();
    let ts = chrono::Utc::now();
    db.store_message("msg-1", "general", "alice", "hello", &ts, None, None, false, None, None);
    db.add_reaction("msg-1", "alice", "👍").unwrap();

    db.delete_message("msg-1").unwrap();
    let reactions = db.get_reactions_batch(&["msg-1".into()]);
    assert!(reactions.is_empty());
}

#[test]
fn delete_reactions_for_message() {
    let db = fresh_db();
    db.register("alice", "password123").unwrap();
    db.register("bob", "password123").unwrap();
    let ts = chrono::Utc::now();
    db.store_message("msg-1", "general", "alice", "hello", &ts, None, None, false, None, None);
    db.add_reaction("msg-1", "alice", "👍").unwrap();
    db.add_reaction("msg-1", "bob", "❤️").unwrap();

    db.delete_reactions_for_message("msg-1");
    let reactions = db.get_reactions_batch(&["msg-1".into()]);
    assert!(reactions.is_empty());
}

#[test]
fn reactions_empty_batch() {
    let db = fresh_db();
    let reactions = db.get_reactions_batch(&[]);
    assert!(reactions.is_empty());
}

// ── Message Pinning ──────────────────────────────────────────────────

#[test]
fn pin_and_unpin_message() {
    let db = fresh_db();
    db.register("alice", "password123").unwrap();
    let ts = chrono::Utc::now();
    db.store_message("msg-1", "general", "alice", "important", &ts, None, None, false, None, None);

    assert!(!db.is_message_pinned("msg-1"));

    db.pin_message("msg-1", true).unwrap();
    assert!(db.is_message_pinned("msg-1"));

    db.pin_message("msg-1", false).unwrap();
    assert!(!db.is_message_pinned("msg-1"));
}

#[test]
fn get_pinned_messages() {
    let db = fresh_db();
    db.register("alice", "password123").unwrap();
    let ts = chrono::Utc::now();
    db.store_message("msg-1", "general", "alice", "pinned msg", &ts, None, None, false, None, None);
    db.store_message("msg-2", "general", "alice", "not pinned", &ts, None, None, false, None, None);
    db.store_message("msg-3", "general", "alice", "also pinned", &ts, None, None, false, None, None);

    db.pin_message("msg-1", true).unwrap();
    db.pin_message("msg-3", true).unwrap();

    let pinned = db.get_pinned_messages("general");
    assert_eq!(pinned.len(), 2);
    assert!(pinned.iter().all(|m| m.pinned));
    let ids: Vec<&str> = pinned.iter().map(|m| m.id.as_str()).collect();
    assert!(ids.contains(&"msg-1"));
    assert!(ids.contains(&"msg-3"));
    assert!(!ids.contains(&"msg-2"));
}

#[test]
fn pinned_field_in_history() {
    let db = fresh_db();
    db.register("alice", "password123").unwrap();
    let ts = chrono::Utc::now();
    db.store_message("msg-1", "general", "alice", "pinned", &ts, None, None, false, None, None);
    db.store_message("msg-2", "general", "alice", "not pinned", &ts, None, None, false, None, None);
    db.pin_message("msg-1", true).unwrap();

    let history = db.get_history("general", 10);
    let msg1 = history.iter().find(|m| m.id == "msg-1").unwrap();
    let msg2 = history.iter().find(|m| m.id == "msg-2").unwrap();
    assert!(msg1.pinned);
    assert!(!msg2.pinned);
}

#[test]
fn pin_nonexistent_message_fails() {
    let db = fresh_db();
    let err = db.pin_message("nonexistent", true).unwrap_err();
    assert!(err.contains("not found"), "got: {err}");
}

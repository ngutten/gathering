use chrono::{Duration, Utc};

use super::Hub;
use crate::protocol::{ServerMsg, TopicReplyData, TopicSummary};

const MAX_TOPIC_TITLE_LEN: usize = 256;
const MAX_TOPIC_BODY_SIZE: usize = 64 * 1024; // 64KB
const DEFAULT_TOPIC_LIST_LIMIT: u32 = 50;
const MAX_TOPIC_LIST_LIMIT: u32 = 50;
const MAX_TOPIC_REPLIES: u32 = 500;

impl Hub {
    pub(super) async fn handle_create_topic(
        &self,
        id: usize,
        channel: String,
        title: String,
        body: String,
        ttl_secs: Option<u64>,
        attachments: Option<Vec<String>>,
        encrypted: bool,
    ) {
        // Input validation (S11)
        if title.len() > MAX_TOPIC_TITLE_LEN {
            self.send_error(id, "Topic title too long (max 256 chars)").await;
            return;
        }
        if body.len() > MAX_TOPIC_BODY_SIZE {
            self.send_error(id, "Topic body too long (max 64KB)").await;
            return;
        }

        let clients = self.clients.lock().await;
        let (username, in_channel) = match clients.get(&id) {
            Some(c) if !c.username.is_empty() => (c.username.clone(), c.channels.contains(&channel)),
            _ => return,
        };

        // S7: membership check
        if !in_channel {
            if let Some(client) = clients.get(&id) {
                if let Err(e) = Self::send_to(&client.tx, &ServerMsg::error("Not a member of this channel")) {
                    eprintln!("[hub::topics] send membership error failed: {e:?}");
                }
            }
            return;
        }

        // S8: permission check
        if !self.db.user_has_permission(&username, "create_topic") {
            if let Some(client) = clients.get(&id) {
                if let Err(e) = Self::send_to(&client.tx, &ServerMsg::error("Permission denied: create_topic")) {
                    eprintln!("[hub::topics] send permission denied error failed: {e:?}");
                }
            }
            return;
        }

        // Ghost mode: enforce channel TTL settings
        let effective_ttl = {
            let force_ghost = self.db.is_channel_force_ghost(&channel);
            let max_ttl = self.db.get_channel_max_ttl(&channel);
            match (ttl_secs, force_ghost, max_ttl) {
                (Some(user_ttl), _, Some(max)) => Some(user_ttl.min(max)),
                (Some(user_ttl), _, None) => Some(user_ttl),
                (None, true, Some(max)) => Some(max),
                (None, true, None) => Some(86400),
                (None, false, _) => None,
            }
        };

        // Anonymous channel: replace author
        let display_author = if self.db.is_channel_anonymous(&channel) {
            "[Anonymous]".to_string()
        } else {
            username.clone()
        };

        let topic_id = uuid::Uuid::new_v4().to_string();
        let now = chrono::Utc::now();
        let now_str = now.to_rfc3339();
        let expires_at = effective_ttl.map(|s| (now + Duration::seconds(s as i64)).to_rfc3339());
        if let Err(e) = self.db.create_topic(
            &topic_id, &channel, &title, &body, &display_author,
            expires_at.as_deref(), attachments.as_ref(), encrypted,
        ) {
            if let Some(client) = clients.get(&id) {
                if let Err(e) = Self::send_to(&client.tx, &ServerMsg::error(e)) {
                    eprintln!("[hub::topics] send create_topic error failed: {e:?}");
                }
            }
            return;
        }

        let summary = TopicSummary {
            id: topic_id,
            channel: channel.clone(),
            title,
            author: display_author,
            created_at: now_str.clone(),
            pinned: false,
            reply_count: 0,
            last_activity: now_str,
            expires_at,
            encrypted,
        };
        Self::broadcast_to_channel_inner(&clients, &channel, &ServerMsg::TopicCreated { topic: summary }, None);
    }

    pub(super) async fn handle_list_topics(&self, id: usize, channel: String, limit: Option<u32>) {
        // Check channel access
        let clients = self.clients.lock().await;
        let username = match clients.get(&id) {
            Some(c) if !c.username.is_empty() => c.username.clone(),
            _ => return,
        };
        if !self.db.can_access_channel(&channel, &username) {
            if let Some(client) = clients.get(&id) {
                let _ = Self::send_to(&client.tx, &ServerMsg::error("Access denied: channel is restricted"));
            }
            return;
        }
        drop(clients);
        let topics = self.db.list_topics(&channel, limit.unwrap_or(DEFAULT_TOPIC_LIST_LIMIT).min(MAX_TOPIC_LIST_LIMIT));
        self.send_msg(id, &ServerMsg::TopicList { channel, topics }).await;
    }

    pub(super) async fn handle_get_topic(&self, id: usize, topic_id: String) {
        let topic = self.db.get_topic(&topic_id);
        let clients = self.clients.lock().await;
        let username = match clients.get(&id) {
            Some(c) if !c.username.is_empty() => c.username.clone(),
            _ => return,
        };
        if let Some(client) = clients.get(&id) {
            match topic {
                Some(t) => {
                    // Check channel access for the topic's channel
                    if !self.db.can_access_channel(&t.channel, &username) {
                        let _ = Self::send_to(&client.tx, &ServerMsg::error("Access denied: channel is restricted"));
                        return;
                    }
                    let replies = self.db.get_topic_replies(&topic_id, MAX_TOPIC_REPLIES);
                    if let Err(e) = Self::send_to(&client.tx, &ServerMsg::TopicDetail { topic: t, replies }) {
                        eprintln!("[hub::topics] send topic detail failed: {e:?}");
                    }
                }
                None => {
                    if let Err(e) = Self::send_to(&client.tx, &ServerMsg::error("Topic not found")) {
                        eprintln!("[hub::topics] send topic not found error failed: {e:?}");
                    }
                }
            }
        }
    }

    pub(super) async fn handle_topic_reply(
        &self,
        id: usize,
        topic_id: String,
        content: String,
        ttl_secs: Option<u64>,
        attachments: Option<Vec<String>>,
        encrypted: bool,
    ) {
        let clients = self.clients.lock().await;
        let username = match clients.get(&id) {
            Some(c) if !c.username.is_empty() => c.username.clone(),
            _ => return,
        };

        // Check channel access via topic's channel
        let topic_channel = if let Some(topic) = self.db.get_topic(&topic_id) {
            if !clients.get(&id).map_or(false, |c| c.channels.contains(&topic.channel)) {
                if let Some(client) = clients.get(&id) {
                    let _ = Self::send_to(&client.tx, &ServerMsg::error("Not a member of this channel"));
                }
                return;
            }
            topic.channel.clone()
        } else {
            String::new()
        };

        // Ghost mode: enforce channel TTL
        let effective_ttl = if !topic_channel.is_empty() {
            let force_ghost = self.db.is_channel_force_ghost(&topic_channel);
            let max_ttl = self.db.get_channel_max_ttl(&topic_channel);
            match (ttl_secs, force_ghost, max_ttl) {
                (Some(user_ttl), _, Some(max)) => Some(user_ttl.min(max)),
                (Some(user_ttl), _, None) => Some(user_ttl),
                (None, true, Some(max)) => Some(max),
                (None, true, None) => Some(86400),
                (None, false, _) => None,
            }
        } else {
            ttl_secs
        };

        // Anonymous channel: replace author
        let display_author = if !topic_channel.is_empty() && self.db.is_channel_anonymous(&topic_channel) {
            "[Anonymous]".to_string()
        } else {
            username.clone()
        };

        let reply_id = uuid::Uuid::new_v4().to_string();
        let now = chrono::Utc::now();
        let now_str = now.to_rfc3339();
        let expires_at = effective_ttl.map(|s| (now + Duration::seconds(s as i64)).to_rfc3339());
        if let Err(e) = self.db.create_topic_reply(
            &reply_id, &topic_id, &display_author, &content,
            expires_at.as_deref(), attachments.as_ref(), encrypted,
        ) {
            if let Some(client) = clients.get(&id) {
                if let Err(e) = Self::send_to(&client.tx, &ServerMsg::error(e)) {
                    eprintln!("[hub::topics] send create_topic_reply error failed: {e:?}");
                }
            }
            return;
        }

        // Look up topic's channel
        let channel = match self.db.get_topic(&topic_id) {
            Some(t) => t.channel,
            None => return,
        };

        // Resolve attachment file IDs to FileInfo
        let file_infos = attachments.as_ref().map(|ids| {
            ids.iter()
                .filter_map(|fid| self.db.get_file(fid))
                .collect::<Vec<_>>()
        }).filter(|v| !v.is_empty());

        let reply = TopicReplyData {
            id: reply_id,
            topic_id: topic_id.clone(),
            author: display_author,
            content,
            created_at: now_str,
            expires_at,
            attachments: file_infos,
            edited_at: None,
            encrypted,
        };
        Self::broadcast_to_channel_inner(&clients, &channel, &ServerMsg::TopicReplyAdded { topic_id, reply }, None);
    }

    pub(super) async fn handle_pin_topic(&self, id: usize, topic_id: String, pinned: bool) {
        let clients = self.clients.lock().await;
        let username = match clients.get(&id) {
            Some(c) if !c.username.is_empty() => c.username.clone(),
            _ => return,
        };

        // Check channel membership via topic's channel
        if let Some(topic) = self.db.get_topic(&topic_id) {
            if !clients.get(&id).map_or(false, |c| c.channels.contains(&topic.channel)) {
                if let Some(client) = clients.get(&id) {
                    let _ = Self::send_to(&client.tx, &ServerMsg::error("Not a member of this channel"));
                }
                return;
            }
        }

        // Check pin_topic permission
        if !self.db.user_has_permission(&username, "pin_topic") {
            if let Some(client) = clients.get(&id) {
                if let Err(e) = Self::send_to(&client.tx, &ServerMsg::error("Permission denied: pin_topic")) {
                    eprintln!("[hub::topics] send permission denied error failed: {e:?}");
                }
            }
            return;
        }

        if let Err(e) = self.db.pin_topic(&topic_id, pinned) {
            if let Some(client) = clients.get(&id) {
                if let Err(e) = Self::send_to(&client.tx, &ServerMsg::error(e)) {
                    eprintln!("[hub::topics] send pin_topic error failed: {e:?}");
                }
            }
            return;
        }

        let channel = match self.db.get_topic(&topic_id) {
            Some(t) => t.channel,
            None => return,
        };

        Self::broadcast_to_channel_inner(&clients, &channel, &ServerMsg::TopicPinned { topic_id, channel: channel.clone(), pinned }, None);
    }

    pub(super) async fn handle_edit_topic(&self, id: usize, topic_id: String, title: Option<String>, body: Option<String>, encrypted: bool) {
        let clients = self.clients.lock().await;
        let username = match clients.get(&id) {
            Some(c) if !c.username.is_empty() => c.username.clone(),
            _ => return,
        };

        let info = match self.db.get_topic_author(&topic_id) {
            Some(i) => i,
            None => {
                if let Some(client) = clients.get(&id) {
                    if let Err(e) = Self::send_to(&client.tx, &ServerMsg::error("Topic not found")) {
                        eprintln!("[hub::topics] send topic not found error failed: {e:?}");
                    }
                }
                return;
            }
        };
        let (author, ref topic_ch) = info;
        // Anonymous channels: reject edits
        if self.db.is_channel_anonymous(topic_ch) {
            if let Some(client) = clients.get(&id) {
                let _ = Self::send_to(&client.tx, &ServerMsg::error("Cannot edit topics in anonymous channels"));
            }
            return;
        }
        if author != username {
            if let Some(client) = clients.get(&id) {
                if let Err(e) = Self::send_to(&client.tx, &ServerMsg::error("Can only edit your own topics")) {
                    eprintln!("[hub::topics] send edit ownership error failed: {e:?}");
                }
            }
            return;
        }
        if !self.db.user_has_permission(&username, "edit_own_topic") {
            if let Some(client) = clients.get(&id) {
                if let Err(e) = Self::send_to(&client.tx, &ServerMsg::error("Permission denied")) {
                    eprintln!("[hub::topics] send permission denied error failed: {e:?}");
                }
            }
            return;
        }

        match self.db.edit_topic(&topic_id, title.as_deref(), body.as_deref()) {
            Ok(ch) => {
                let now = Utc::now().to_rfc3339();
                Self::broadcast_to_channel_inner(&clients, &ch, &ServerMsg::TopicEdited {
                    topic_id, channel: ch.clone(), title, body, edited_at: now, encrypted,
                }, None);
            }
            Err(e) => {
                if let Some(client) = clients.get(&id) {
                    if let Err(e) = Self::send_to(&client.tx, &ServerMsg::error(e)) {
                        eprintln!("[hub::topics] send edit_topic error failed: {e:?}");
                    }
                }
            }
        }
    }

    pub(super) async fn handle_delete_topic(&self, id: usize, topic_id: String) {
        let clients = self.clients.lock().await;
        let username = match clients.get(&id) {
            Some(c) if !c.username.is_empty() => c.username.clone(),
            _ => return,
        };

        let info = match self.db.get_topic_author(&topic_id) {
            Some(i) => i,
            None => {
                if let Some(client) = clients.get(&id) {
                    if let Err(e) = Self::send_to(&client.tx, &ServerMsg::error("Topic not found")) {
                        eprintln!("[hub::topics] send topic not found error failed: {e:?}");
                    }
                }
                return;
            }
        };
        let (author, ref topic_ch) = info;
        // Anonymous channels: only admin with delete_any_message can delete
        if self.db.is_channel_anonymous(topic_ch) {
            if !self.db.user_has_permission(&username, "delete_any_message") {
                if let Some(client) = clients.get(&id) {
                    let _ = Self::send_to(&client.tx, &ServerMsg::error("Cannot delete topics in anonymous channels (admin only)"));
                }
                return;
            }
        } else if author == username {
            if !self.db.user_has_permission(&username, "delete_own_topic") {
                if let Some(client) = clients.get(&id) {
                    if let Err(e) = Self::send_to(&client.tx, &ServerMsg::error("Permission denied")) {
                        eprintln!("[hub::topics] send permission denied error failed: {e:?}");
                    }
                }
                return;
            }
        } else {
            if !self.db.user_has_permission(&username, "delete_any_message") {
                if let Some(client) = clients.get(&id) {
                    if let Err(e) = Self::send_to(&client.tx, &ServerMsg::error("Permission denied")) {
                        eprintln!("[hub::topics] send permission denied error failed: {e:?}");
                    }
                }
                return;
            }
        }

        match self.db.delete_topic(&topic_id) {
            Ok(ch) => {
                Self::broadcast_to_channel_inner(&clients, &ch, &ServerMsg::TopicDeleted {
                    topic_id, channel: ch.clone(),
                }, None);
            }
            Err(e) => {
                if let Some(client) = clients.get(&id) {
                    if let Err(e) = Self::send_to(&client.tx, &ServerMsg::error(e)) {
                        eprintln!("[hub::topics] send delete_topic error failed: {e:?}");
                    }
                }
            }
        }
    }

    pub(super) async fn handle_edit_topic_reply(&self, id: usize, reply_id: String, content: String, encrypted: bool) {
        let clients = self.clients.lock().await;
        let username = match clients.get(&id) {
            Some(c) if !c.username.is_empty() => c.username.clone(),
            _ => return,
        };

        let info = match self.db.get_reply_author(&reply_id) {
            Some(i) => i,
            None => {
                if let Some(client) = clients.get(&id) {
                    if let Err(e) = Self::send_to(&client.tx, &ServerMsg::error("Reply not found")) {
                        eprintln!("[hub::topics] send reply not found error failed: {e:?}");
                    }
                }
                return;
            }
        };
        let (author, ref reply_topic_id) = info;
        // Anonymous channels: reject edits on replies
        if let Some(topic) = self.db.get_topic(reply_topic_id) {
            if self.db.is_channel_anonymous(&topic.channel) {
                if let Some(client) = clients.get(&id) {
                    let _ = Self::send_to(&client.tx, &ServerMsg::error("Cannot edit replies in anonymous channels"));
                }
                return;
            }
        }
        if author != username {
            if let Some(client) = clients.get(&id) {
                if let Err(e) = Self::send_to(&client.tx, &ServerMsg::error("Can only edit your own replies")) {
                    eprintln!("[hub::topics] send edit ownership error failed: {e:?}");
                }
            }
            return;
        }
        if !self.db.user_has_permission(&username, "edit_own_message") {
            if let Some(client) = clients.get(&id) {
                if let Err(e) = Self::send_to(&client.tx, &ServerMsg::error("Permission denied")) {
                    eprintln!("[hub::topics] send permission denied error failed: {e:?}");
                }
            }
            return;
        }

        match self.db.edit_topic_reply(&reply_id, &content) {
            Ok((topic_id, _)) => {
                let now = Utc::now().to_rfc3339();
                // Broadcast to the topic's channel
                if let Some(topic) = self.db.get_topic(&topic_id) {
                    Self::broadcast_to_channel_inner(&clients, &topic.channel, &ServerMsg::TopicReplyEdited {
                        reply_id, topic_id, content, edited_at: now, encrypted,
                    }, None);
                }
            }
            Err(e) => {
                if let Some(client) = clients.get(&id) {
                    if let Err(e) = Self::send_to(&client.tx, &ServerMsg::error(e)) {
                        eprintln!("[hub::topics] send edit_topic_reply error failed: {e:?}");
                    }
                }
            }
        }
    }

    pub(super) async fn handle_delete_topic_reply(&self, id: usize, reply_id: String) {
        let clients = self.clients.lock().await;
        let username = match clients.get(&id) {
            Some(c) if !c.username.is_empty() => c.username.clone(),
            _ => return,
        };

        let info = match self.db.get_reply_author(&reply_id) {
            Some(i) => i,
            None => {
                if let Some(client) = clients.get(&id) {
                    if let Err(e) = Self::send_to(&client.tx, &ServerMsg::error("Reply not found")) {
                        eprintln!("[hub::topics] send reply not found error failed: {e:?}");
                    }
                }
                return;
            }
        };
        let (author, ref del_reply_topic_id) = info;
        // Anonymous channels: only admin with delete_any_message can delete
        let is_anon_channel = self.db.get_topic(del_reply_topic_id)
            .map(|t| self.db.is_channel_anonymous(&t.channel))
            .unwrap_or(false);
        if is_anon_channel {
            if !self.db.user_has_permission(&username, "delete_any_message") {
                if let Some(client) = clients.get(&id) {
                    let _ = Self::send_to(&client.tx, &ServerMsg::error("Cannot delete replies in anonymous channels (admin only)"));
                }
                return;
            }
        } else if author == username {
            if !self.db.user_has_permission(&username, "delete_own_message") {
                if let Some(client) = clients.get(&id) {
                    if let Err(e) = Self::send_to(&client.tx, &ServerMsg::error("Permission denied")) {
                        eprintln!("[hub::topics] send permission denied error failed: {e:?}");
                    }
                }
                return;
            }
        } else {
            if !self.db.user_has_permission(&username, "delete_any_message") {
                if let Some(client) = clients.get(&id) {
                    if let Err(e) = Self::send_to(&client.tx, &ServerMsg::error("Permission denied")) {
                        eprintln!("[hub::topics] send permission denied error failed: {e:?}");
                    }
                }
                return;
            }
        }

        match self.db.delete_topic_reply(&reply_id) {
            Ok((topic_id, _)) => {
                if let Some(topic) = self.db.get_topic(&topic_id) {
                    Self::broadcast_to_channel_inner(&clients, &topic.channel, &ServerMsg::TopicReplyDeleted {
                        reply_id, topic_id,
                    }, None);
                }
            }
            Err(e) => {
                if let Some(client) = clients.get(&id) {
                    if let Err(e) = Self::send_to(&client.tx, &ServerMsg::error(e)) {
                        eprintln!("[hub::topics] send delete_topic_reply error failed: {e:?}");
                    }
                }
            }
        }
    }
}

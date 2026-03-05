<!DOCTYPE html><html lang="en"><head><script>// Copyright 2019-2024 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

// taken from https://github.com/thedodd/trunk/blob/5c799dc35f1f1d8f8d3d30c8723cbb761a9b6a08/src/autoreload.js

;(function () {
  const reload_url = 'ws://127.0.0.1:1430/__tauri_cli'
  const url = reload_url ? reload_url : window.location.href
  const poll_interval = 5000
  const reload_upon_connect = () => {
    window.setTimeout(() => {
      // when we successfully reconnect, we'll force a
      // reload (since we presumably lost connection to
      // tauri-cli due to it being killed)
      const ws = new WebSocket(url)
      ws.onopen = () => window.location.reload()
      ws.onclose = reload_upon_connect
    }, poll_interval)
  }

  const ws = new WebSocket(url)
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.reload) {
      window.location.reload()
    }
  }
  ws.onclose = reload_upon_connect
})()
</script>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Gathering</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css">
<script defer="" src="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.js"></script>
<link rel="stylesheet" href="css/styles.css">
</head>
<body>

<!-- Auth Screen -->
<div id="auth-screen">
  <div class="auth-box">
    <h1>⎁ Gathering</h1>
    <p>self-hosted · encrypted · ephemeral</p>
    <div class="auth-error" id="auth-error"></div>
    <input type="text" id="username" placeholder="username" autocomplete="username">
    <input type="password" id="password" placeholder="password" autocomplete="current-password">
    <input type="text" id="invite-code" placeholder="invite code" style="display:none">
    <div class="auth-buttons">
      <button class="btn-primary" onclick="doLogin()">Login</button>
      <button class="btn-secondary" id="register-btn" onclick="doRegister()">Register</button>
    </div>
  </div>
</div>

<!-- Chat Screen -->
<div id="chat-screen">
  <div class="layout">
    <div class="sidebar">
      <div class="sidebar-header">
        <div class="sidebar-header-left">
          <h2>⎁ Gathering</h2>
          <div class="user-info">logged in as <strong id="display-user"></strong></div>
        </div>
        <button class="admin-btn" id="admin-gear-btn" style="display:none" onclick="openAdminPanel()" title="Admin">⚙</button>
      </div>
      <div class="sidebar-section">
        <h3>Channels</h3>
        <div id="channel-list"></div>
        <div class="join-channel">
          <input type="text" id="new-channel" placeholder="join or create #channel" onkeydown="if(event.key==='Enter')joinChannel()">
          <label style="display:flex;align-items:center;gap:0.3rem;font-size:0.7rem;color:var(--text2);margin-top:0.3rem;cursor:pointer;">
            <input type="checkbox" id="encrypted-channel-check"> Encrypted (E2E)
          </label>
        </div>
      </div>
      <div class="sidebar-section" id="dm-section">
        <h3>Direct Messages</h3>
        <div id="dm-list"></div>
      </div>
      <div class="sidebar-section">
        <h3>Online</h3>
        <div id="online-users"></div>
      </div>
      <div class="voice-section">
        <h3>Voice</h3>
        <div class="voice-status" id="voice-status">Not connected</div>
        <div id="voice-members"></div>
        <div class="voice-controls" id="voice-controls" style="display:none;">
          <button id="mute-btn" onclick="toggleMute()">Mute</button>
          <button id="deafen-btn" onclick="toggleDeafen()">Deafen</button>
        </div>
        <button class="voice-btn voice-join" id="voice-join-btn" onclick="joinVoice()">Join Voice</button>
        <button class="voice-btn voice-leave" id="voice-leave-btn" onclick="leaveVoice()" style="display:none;">Leave Voice</button>
      </div>
      <div class="sidebar-bottom">
        <div style="margin-bottom:0.3rem;">E2E: <code id="key-fingerprint" style="font-size:0.65rem;color:var(--green);"></code></div>
        <div style="display:flex;gap:0.3rem;">
          <button onclick="exportPrivateKey()" style="padding:0.15rem 0.4rem;background:var(--bg3);border:1px solid var(--border);border-radius:3px;color:var(--text2);cursor:pointer;font-family:inherit;font-size:0.65rem;">Export Key</button>
          <button onclick="importPrivateKey()" style="padding:0.15rem 0.4rem;background:var(--bg3);border:1px solid var(--border);border-radius:3px;color:var(--text2);cursor:pointer;font-family:inherit;font-size:0.65rem;">Import Key</button>
        </div>
      </div>
    </div>
    <div class="chat-main">
      <div class="chat-header">
        <h2 id="chat-channel-name">#general</h2>
        <span class="typing" id="typing-indicator"></span>
        <div class="view-toggle">
          <button id="view-chat-btn" class="active" onclick="switchView('chat')">Chat</button>
          <button id="view-topics-btn" onclick="switchView('topics')">Topics</button>
        </div>
      </div>

      <!-- Chat view -->
      <div id="chat-view">
        <div class="messages" id="messages"></div>
        <div class="edit-banner" id="edit-banner">
          <span>Editing message - <em>Escape</em> to cancel</span>
          <button onclick="cancelEdit()">Cancel</button>
        </div>
        <div class="input-area">
          <div class="input-row">
            <button class="attach-btn" onclick="document.getElementById('file-input').click()" title="Attach file">📎</button>
            <input type="file" id="file-input" style="display:none" multiple="" onchange="handleFileSelect(event)">
            <textarea id="msg-input" rows="1" placeholder="Type a message..." onkeydown="handleInputKey(event)"></textarea>
            <div class="ttl-control">
              <label>TTL</label>
              <select id="ttl-select">
                <option value="">∞</option>
                <option value="60">1m</option>
                <option value="300">5m</option>
                <option value="3600">1h</option>
                <option value="86400">1d</option>
                <option value="604800">7d</option>
              </select>
            </div>
            <button class="send-btn" id="send-btn" onclick="sendMessage()">Send</button>
          </div>
          <div class="pending-files" id="pending-files"></div>
          <div class="upload-progress" id="upload-progress"></div>
        </div>
      </div>

      <!-- Topics list view -->
      <div id="topics-view" style="display:none;">
        <div class="topic-list" id="topic-list">
          <div class="topic-empty">No topics yet. Create one below.</div>
        </div>
        <div class="new-topic-form">
          <input type="text" id="new-topic-title" placeholder="Topic title..." onkeydown="if(event.key==='Enter'&amp;&amp;!event.shiftKey){event.preventDefault();createTopic();}">
          <textarea id="new-topic-body" rows="3" placeholder="Topic body (supports markdown)..."></textarea>
          <div class="input-row" style="margin-top:0.4rem;">
            <button class="attach-btn" onclick="document.getElementById('topic-file-input').click()" title="Attach file">📎</button>
            <input type="file" id="topic-file-input" style="display:none" multiple="" onchange="handleTopicFileSelect(event)">
            <div class="ttl-control">
              <label>TTL</label>
              <select id="topic-ttl-select">
                <option value="">∞</option>
                <option value="60">1m</option>
                <option value="300">5m</option>
                <option value="3600">1h</option>
                <option value="86400">1d</option>
                <option value="604800">7d</option>
              </select>
            </div>
            <button class="send-btn" onclick="createTopic()" style="flex:1;">Create Topic</button>
          </div>
          <div class="pending-files" id="topic-pending-files"></div>
          <div class="upload-progress" id="topic-upload-progress"></div>
        </div>
      </div>

      <!-- Topic thread view -->
      <div id="thread-view" style="display:none;">
        <div class="thread-header">
          <div class="thread-back" onclick="backToTopics()">← Back to topics</div>
          <div class="thread-title-row">
            <div class="thread-title" id="thread-title"></div>
            <button class="thread-pin-btn" id="thread-pin-btn" onclick="togglePinTopic()">Pin</button>
            <button class="thread-pin-btn" id="thread-edit-btn" style="display:none" onclick="startEditTopic()">Edit</button>
            <button class="thread-pin-btn" id="thread-delete-btn" style="display:none" onclick="deleteCurrentTopic()">Delete</button>
          </div>
          <div class="topic-meta" id="thread-meta"></div>
        </div>
        <div class="thread-body" id="thread-body"></div>
        <div class="thread-replies" id="thread-replies"></div>
        <div class="input-area">
          <div class="input-row">
            <button class="attach-btn" onclick="document.getElementById('reply-file-input').click()" title="Attach file">📎</button>
            <input type="file" id="reply-file-input" style="display:none" multiple="" onchange="handleReplyFileSelect(event)">
            <textarea id="reply-input" rows="1" placeholder="Write a reply..." onkeydown="handleReplyKey(event)"></textarea>
            <div class="ttl-control">
              <label>TTL</label>
              <select id="reply-ttl-select">
                <option value="">∞</option>
                <option value="60">1m</option>
                <option value="300">5m</option>
                <option value="3600">1h</option>
                <option value="86400">1d</option>
                <option value="604800">7d</option>
              </select>
            </div>
            <button class="send-btn" onclick="sendReply()">Reply</button>
          </div>
          <div class="pending-files" id="reply-pending-files"></div>
          <div class="upload-progress" id="reply-upload-progress"></div>
        </div>
      </div>
    </div>
  </div>
</div>

<!-- Admin Panel Overlay -->
<div class="admin-overlay" id="admin-overlay" onclick="if(event.target===this)closeAdminPanel()">
  <div class="admin-panel">
    <div class="admin-panel-header">
      <h2>Admin Panel</h2>
      <button class="admin-panel-close" onclick="closeAdminPanel()">×</button>
    </div>
    <div class="admin-tabs">
      <button class="active" onclick="switchAdminTab('settings', this)">Settings</button>
      <button onclick="switchAdminTab('invites', this)">Invites</button>
      <button onclick="switchAdminTab('roles', this)">Roles</button>
    </div>
    <div class="admin-tab-content" id="admin-tab-content">
      <!-- Filled dynamically -->
    </div>
  </div>
</div>

<script src="js/sodium-loader.js"></script>
<script src="js/tauri-bridge.js"></script>
<script type="module" src="js/app.js"></script>
<script type="module">
  // Debug: verify modules loaded
  import('./js/config.js').then(m => {
    console.log('[gathering] isTauri:', m.isTauri, 'apiUrl test:', m.apiUrl('/api/login'));
  }).catch(e => console.error('[gathering] Module load failed:', e));
</script>


</body></html>
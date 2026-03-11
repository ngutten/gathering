// tauri-bridge.js — Tauri-specific: server rail, multi-server switching (classic script)
//
// Loaded only when running inside the Tauri webview.
// Provides server rail UI and multi-server management.

(function() {
  // Tauri v2 exposes __TAURI_INTERNALS__
  if (!window.__TAURI_INTERNALS__) return;

  // Mark for detection by config.js
  window.__TAURI__ = true;
  document.body.classList.add('tauri-mode');

  // ── Storage helpers (wait for gatheringStorage to be set by storage.js module) ──
  function store() { return window.gatheringStorage; }

  function escapeText(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  // ── Server snapshots (in-memory, per-server state) ──
  const serverSnapshots = {};

  // ── Server health tracking ──
  const serverOnlineStatus = {}; // url -> boolean (true = online, false = offline)
  let healthCheckTimer = null;

  // ── Color hash for server icons ──
  function serverColor(url) {
    let hash = 0;
    for (let i = 0; i < url.length; i++) {
      hash = ((hash << 5) - hash) + url.charCodeAt(i);
      hash |= 0;
    }
    const hue = Math.abs(hash) % 360;
    return `hsl(${hue}, 60%, 45%)`;
  }

  function serverLabel(url) {
    try {
      const u = new URL(url);
      return u.hostname.charAt(0).toUpperCase();
    } catch {
      return url.charAt(0).toUpperCase();
    }
  }

  function serverDisplayName(url) {
    try {
      const u = new URL(url);
      return u.host;
    } catch {
      return url;
    }
  }

  // ── Switch server logic ──
  function switchServer(url) {
    const s = store();
    const currentUrl = s.getActiveServer();
    if (currentUrl === url) return;

    // 1. Snapshot current state (if connected)
    if (currentUrl && window._gatheringState) {
      const state = window._gatheringState;

      // Cleanup voice if active
      if (state.inVoiceChannel && window._cleanupVoice) {
        window._cleanupVoice();
      }

      // Clear widget presence for current channel/user
      if (window._clearUserPresence && state.currentChannel && state.currentUser) {
        window._clearUserPresence(state.currentChannel, state.currentUser);
      }

      // Snapshot state
      if (window._snapshotState) {
        serverSnapshots[currentUrl] = window._snapshotState();
      }

      // Close WebSocket cleanly
      if (state.ws) {
        state.ws.onmessage = null;
        state.ws.onclose = null;
        state.ws.close();
        state.ws = null;
      }

      // Reset state
      if (window._resetState) {
        window._resetState();
      }
    }

    // 2. Set new active server
    s.setActiveServer(url);

    // 3. Restore state for target server
    if (serverSnapshots[url] && window._restoreState) {
      window._restoreState(serverSnapshots[url]);
    } else if (window._gatheringState) {
      // Load token from scoped storage
      const state = window._gatheringState;
      state.token = s.scopedGet('token');
      // Load last-read timestamps
      state.lastReadTimestamps = {};
      for (const { suffix, value } of s.scopedEntries('last_read_')) {
        state.lastReadTimestamps[suffix] = value;
      }
    }

    // 4. Clear DOM
    const messages = document.getElementById('messages');
    if (messages) messages.innerHTML = '';
    const channelList = document.getElementById('channel-list');
    if (channelList) channelList.innerHTML = '';
    const dmList = document.getElementById('dm-list');
    if (dmList) dmList.innerHTML = '';
    const onlineUsers = document.getElementById('online-users');
    if (onlineUsers) onlineUsers.innerHTML = '';
    const voiceChannelList = document.getElementById('voice-channel-list');
    if (voiceChannelList) voiceChannelList.innerHTML = '';
    const voiceMembers = document.getElementById('voice-members');
    if (voiceMembers) voiceMembers.innerHTML = '';
    const keyRequests = document.getElementById('key-requests');
    if (keyRequests) keyRequests.innerHTML = '';
    const widgetPanel = document.getElementById('widget-panel');
    if (widgetPanel) { widgetPanel.innerHTML = ''; widgetPanel.style.display = 'none'; }

    // Reset channel header
    const channelName = document.getElementById('chat-channel-name');
    if (channelName) channelName.textContent = '#general';

    // 5. Connect or show auth
    const state = window._gatheringState;
    if (state && state.token) {
      document.getElementById('auth-screen').style.display = 'none';
      document.getElementById('chat-screen').style.display = 'flex';
      if (window._connectWS) window._connectWS();
    } else {
      document.getElementById('chat-screen').style.display = 'none';
      document.getElementById('auth-screen').style.display = 'flex';
      document.getElementById('password').value = '';
      // Check server info for new server
      if (window._checkServerInfo) window._checkServerInfo();
    }

    // 6. Update rail highlight + auth server info
    renderServerRail();
    updateAuthServerInfo();
  }

  // ── Auth screen server indicator ──
  function updateAuthServerInfo() {
    const el = document.getElementById('auth-server-info');
    if (!el) return;
    const s = store();
    const url = s ? s.getActiveServer() : '';
    if (!url) {
      el.innerHTML = '';
      return;
    }
    const st = window._gatheringState;
    const name = (st && st.serverName) || serverDisplayName(url);
    el.innerHTML = `<span>Server: <span class="server-name">${escapeText(name)}</span></span>` +
      `<span class="server-change" onclick="configureServer()">change</span>`;
  }

  // ── Server Rail UI ──
  function renderServerRail() {
    const s = store();
    if (!s) return;

    const rail = document.getElementById('server-rail');
    if (!rail) return;

    const history = s.getServerHistory();
    const activeUrl = s.getActiveServer();

    let html = '';

    // Server icons
    const st = window._gatheringState;
    history.forEach((url) => {
      const isActive = url === activeUrl;
      const hasToken = s.serverHasToken(url);
      const color = serverColor(url);
      // Use server branding for the active server if available
      const hasIcon = isActive && st && st.serverIcon;
      const label = hasIcon ? null : serverLabel(url);
      const brandName = (isActive && st && st.serverName) ? st.serverName : null;
      const displayName = brandName || serverDisplayName(url);

      const isOffline = serverOnlineStatus[url] === false;
      const offlineClass = isOffline ? ' offline' : '';
      html += `<div class="server-icon${isActive ? ' active' : ''}${offlineClass}" data-url="${escapeText(url)}" title="${escapeText(displayName)}${isOffline ? ' (offline)' : ''}">`;
      if (hasIcon) {
        html += `<img class="server-icon-circle" src="${escapeText(st.serverIcon)}" alt="${escapeText(displayName)}" style="object-fit:cover;">`;
      } else {
        html += `<div class="server-icon-circle" style="background:${color};">${label}</div>`;
      }
      if (hasToken) html += '<div class="server-indicator"></div>';
      html += '<div class="server-offline-dot"></div>';
      html += '</div>';
    });

    // Add button
    html += '<div class="server-add-btn" title="Add server">+</div>';

    rail.innerHTML = html;

    // Wire click events
    rail.querySelectorAll('.server-icon').forEach(el => {
      el.addEventListener('click', () => {
        switchServer(el.dataset.url);
      });

      // Right-click context menu
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showServerContextMenu(e.clientX, e.clientY, el.dataset.url);
      });
    });

    rail.querySelector('.server-add-btn').addEventListener('click', showAddServerModal);
  }

  // ── Context menu ──
  function showServerContextMenu(x, y, url) {
    // Remove existing menu
    const existing = document.getElementById('server-context-menu');
    if (existing) existing.remove();

    const menu = document.createElement('div');
    menu.id = 'server-context-menu';
    menu.className = 'server-context-menu';
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';

    const s = store();
    const hasToken = s.serverHasToken(url);
    const displayName = serverDisplayName(url);

    let html = `<div class="server-ctx-header">${escapeText(displayName)}</div>`;
    if (hasToken) {
      html += '<div class="server-ctx-item" data-action="logout">Log out</div>';
    }
    html += '<div class="server-ctx-item server-ctx-danger" data-action="remove">Remove server</div>';

    menu.innerHTML = html;
    document.body.appendChild(menu);

    // Position: keep in viewport
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) menu.style.left = (window.innerWidth - rect.width - 8) + 'px';
    if (rect.bottom > window.innerHeight) menu.style.top = (window.innerHeight - rect.height - 8) + 'px';

    menu.addEventListener('click', (e) => {
      const action = e.target.dataset.action;
      if (action === 'logout') {
        // Clear token but keep in list
        const scope = url;
        // Use removeServerData-like approach but only for token
        const scopeKey = (() => { try { return new URL(url).host; } catch { return url; } })();
        localStorage.removeItem(`gathering@${scopeKey}:token`);
        // If this is the active server, show auth screen
        if (s.getActiveServer() === url && window._gatheringState) {
          window._gatheringState.token = null;
          if (window._gatheringState.ws) {
            window._gatheringState.ws.onclose = null;
            window._gatheringState.ws.close();
            window._gatheringState.ws = null;
          }
          document.getElementById('chat-screen').style.display = 'none';
          document.getElementById('auth-screen').style.display = 'flex';
        }
        // Clear snapshot
        delete serverSnapshots[url];
        renderServerRail();
      } else if (action === 'remove') {
        const deleteData = confirm(`Remove ${displayName}?\n\nClick OK to also delete saved data (token, keys, TOFU pins, read state).`);
        if (deleteData) {
          s.removeServerData(url);
        }
        s.removeServerFromHistory(url);
        delete serverSnapshots[url];
        // If removing active server, switch to next or show picker
        if (s.getActiveServer() === url) {
          const remaining = s.getServerHistory();
          if (remaining.length > 0) {
            switchServer(remaining[0]);
          } else {
            s.setActiveServer('');
            showFirstLaunchPicker();
          }
        }
        renderServerRail();
      }
      menu.remove();
    });

    // Close on click elsewhere
    const closeMenu = (e) => {
      if (!menu.contains(e.target)) {
        menu.remove();
        document.removeEventListener('click', closeMenu);
      }
    };
    setTimeout(() => document.addEventListener('click', closeMenu), 0);
  }

  // ── Add Server Modal ──
  function showAddServerModal() {
    const existing = document.getElementById('add-server-modal');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'add-server-modal';
    overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.7);z-index:9999;display:flex;align-items:center;justify-content:center;';

    const box = document.createElement('div');
    box.style.cssText = 'background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:1.5rem;width:380px;color:var(--text);font-family:inherit;';
    box.innerHTML = `
      <h3 style="margin:0 0 0.5rem 0;font-size:1rem;color:var(--accent);">Add Server</h3>
      <p style="font-size:0.8rem;color:var(--text2);margin:0 0 1rem 0;">Enter the server URL to connect.</p>
      <input type="text" id="add-server-url" placeholder="https://gather.example.com"
             style="width:100%;padding:0.5rem 0.7rem;background:var(--bg);border:1px solid var(--border);border-radius:4px;color:var(--text);font-family:inherit;font-size:0.85rem;box-sizing:border-box;margin-bottom:0.5rem;">
      <div id="add-server-error" style="color:var(--red);font-size:0.75rem;margin-bottom:0.5rem;"></div>
      <div style="display:flex;gap:0.5rem;justify-content:flex-end;">
        <button id="add-server-cancel" style="padding:0.3rem 0.8rem;background:var(--bg3);border:1px solid var(--border);border-radius:4px;color:var(--text2);cursor:pointer;font-family:inherit;font-size:0.8rem;">Cancel</button>
        <button id="add-server-connect" style="padding:0.3rem 0.8rem;background:var(--accent2);color:#fff;border:none;border-radius:4px;cursor:pointer;font-family:inherit;font-size:0.8rem;">Connect</button>
      </div>
    `;
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    const urlInput = document.getElementById('add-server-url');
    const errEl = document.getElementById('add-server-error');

    function doConnect() {
      const url = urlInput.value.trim().replace(/\/$/, '');
      if (!url) { errEl.textContent = 'Enter a URL'; return; }
      try { new URL(url); } catch { errEl.textContent = 'Invalid URL'; return; }
      const s = store();
      s.addServerToHistory(url);
      overlay.remove();
      switchServer(url);
    }

    document.getElementById('add-server-connect').addEventListener('click', doConnect);
    urlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doConnect(); });
    document.getElementById('add-server-cancel').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    urlInput.focus();
  }

  // ── First-launch: show full-screen server picker ──
  function showFirstLaunchPicker() {
    const s = store();
    const history = s ? s.getServerHistory() : [];

    // Hide other screens
    const authScreen = document.getElementById('auth-screen');
    const chatScreen = document.getElementById('chat-screen');
    const rail = document.getElementById('server-rail');
    if (authScreen) authScreen.style.display = 'none';
    if (chatScreen) chatScreen.style.display = 'none';
    if (rail) rail.style.display = 'none';

    const existing = document.getElementById('server-picker');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'server-picker';
    overlay.style.cssText = 'display:flex;align-items:center;justify-content:center;width:100%;height:100%;position:fixed;top:0;left:0;z-index:1000;background:var(--bg);';

    const box = document.createElement('div');
    box.style.cssText = 'background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:2rem;width:380px;max-height:80vh;overflow-y:auto;';

    let html = '<h1 style="font-size:1.4rem;margin-bottom:0.3rem;color:var(--accent);">&#x2381; Gathering</h1>';
    html += '<p style="font-size:0.8rem;color:var(--text2);margin-bottom:1.5rem;">Connect to a server</p>';

    if (history.length > 0) {
      html += '<div style="margin-bottom:1rem;">';
      html += '<div style="font-size:0.7rem;text-transform:uppercase;color:var(--text2);letter-spacing:0.05em;margin-bottom:0.5rem;">Recent servers</div>';
      history.forEach((url, i) => {
        html += '<div style="display:flex;align-items:center;gap:0.5rem;margin-bottom:0.4rem;">';
        html += `<button data-connect="${i}" style="flex:1;text-align:left;padding:0.5rem 0.7rem;background:var(--bg);border:1px solid var(--border);border-radius:4px;color:var(--text);font-family:inherit;font-size:0.85rem;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeText(url)}</button>`;
        html += '</div>';
      });
      html += '</div>';
    }

    html += '<div style="border-top:1px solid var(--border);padding-top:1rem;">';
    html += '<div style="font-size:0.7rem;text-transform:uppercase;color:var(--text2);letter-spacing:0.05em;margin-bottom:0.5rem;">New server</div>';
    html += '<div style="display:flex;gap:0.5rem;">';
    html += '<input id="first-server-url" type="text" placeholder="https://gather.example.com" style="flex:1;padding:0.5rem 0.7rem;background:var(--bg);border:1px solid var(--border);border-radius:4px;color:var(--text);font-family:inherit;font-size:0.85rem;">';
    html += '<button id="first-connect-btn" style="padding:0.5rem 1rem;background:var(--accent2);color:#fff;border:none;border-radius:4px;cursor:pointer;font-family:inherit;font-size:0.85rem;">Connect</button>';
    html += '</div></div>';

    box.innerHTML = html;
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    function connectTo(url) {
      const cleaned = url.trim().replace(/\/$/, '');
      if (!cleaned) return;
      const s = store();
      s.addServerToHistory(cleaned);
      s.setActiveServer(cleaned);
      overlay.remove();
      // Reload to initialize with new server
      location.reload();
    }

    box.querySelectorAll('[data-connect]').forEach(btn => {
      btn.addEventListener('click', () => connectTo(history[parseInt(btn.dataset.connect)]));
    });

    const connectBtn = document.getElementById('first-connect-btn');
    const urlInput = document.getElementById('first-server-url');
    connectBtn.addEventListener('click', () => connectTo(urlInput.value));
    urlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') connectTo(urlInput.value); });
    urlInput.focus();
  }

  // ── Server health checks (non-active servers) ──
  async function checkServerHealth(url) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(url + '/api/server-info', { signal: controller.signal });
      clearTimeout(timeout);
      return res.ok;
    } catch {
      return false;
    }
  }

  async function runHealthChecks() {
    const s = store();
    if (!s) return;
    const history = s.getServerHistory();
    const activeUrl = s.getActiveServer();
    let changed = false;
    for (const url of history) {
      if (url === activeUrl) continue; // active server status comes from WS
      const online = await checkServerHealth(url);
      if (serverOnlineStatus[url] !== online) {
        serverOnlineStatus[url] = online;
        changed = true;
      }
    }
    if (changed) renderServerRail();
  }

  function startHealthChecks() {
    if (healthCheckTimer) return;
    runHealthChecks();
    healthCheckTimer = setInterval(runHealthChecks, 30000);
  }

  // Track active server status from WS connection state
  function onConnectionStateChange(s) {
    const st = store();
    if (!st) return;
    const activeUrl = st.getActiveServer();
    if (!activeUrl) return;
    const wasOnline = serverOnlineStatus[activeUrl];
    serverOnlineStatus[activeUrl] = (s === 'connected');
    if (wasOnline !== serverOnlineStatus[activeUrl]) {
      renderServerRail();
      updateOfflineOverlay();
    }
  }

  function updateOfflineOverlay() {
    const st = store();
    if (!st) return;
    const activeUrl = st.getActiveServer();
    const isOffline = activeUrl && serverOnlineStatus[activeUrl] === false;
    let overlay = document.getElementById('server-offline-overlay');
    if (isOffline) {
      if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'server-offline-overlay';
        overlay.className = 'server-offline-overlay';
        overlay.textContent = 'Server offline';
        const layout = document.querySelector('.layout');
        if (layout) layout.style.position = 'relative';
        if (layout) layout.appendChild(overlay);
      }
    } else {
      if (overlay) overlay.remove();
    }
  }

  // Listen for connection state events from transport.js module
  // We need to poll for the event emitter since tauri-bridge loads before ES modules
  function wireConnectionEvents() {
    if (window._gatheringState && window._gatheringState._onConnectionState) {
      window._gatheringState._onConnectionState(onConnectionStateChange);
    } else {
      // Fallback: check periodically
      setTimeout(wireConnectionEvents, 200);
    }
  }

  // ── Initialization ──
  function init() {
    const s = store();
    if (!s) {
      // Storage module not loaded yet, retry
      setTimeout(init, 50);
      return;
    }

    // Migration: handle old gathering_server_url key
    const legacyUrl = localStorage.getItem('gathering_server_url');
    if (legacyUrl && !s.getActiveServer()) {
      s.setActiveServer(legacyUrl);
      s.addServerToHistory(legacyUrl);
      localStorage.removeItem('gathering_server_url');
    }

    const serverUrl = s.getActiveServer();
    if (!serverUrl) {
      showFirstLaunchPicker();
      return;
    }

    // Ensure active server is in history
    const history = s.getServerHistory();
    if (!history.includes(serverUrl)) {
      s.addServerToHistory(serverUrl);
    }

    // Render rail once DOM is ready
    renderServerRail();
    updateAuthServerInfo();
    startHealthChecks();
    wireConnectionEvents();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    // Storage module might not be loaded yet if script runs before modules
    setTimeout(init, 0);
  }

  // ── Tray badge: track unread state and update native tray icon ──
  let lastBadgeState = false;
  async function updateTrayBadge(hasUnread) {
    if (hasUnread === lastBadgeState) return;
    lastBadgeState = hasUnread;
    try {
      const { invoke } = window.__TAURI_INTERNALS__;
      await invoke('set_unread_badge', { hasUnread });
    } catch (e) {
      console.warn('[tray] badge update failed:', e);
    }
  }

  // Poll unread counts to update tray badge
  function checkUnreadForBadge() {
    const st = window._gatheringState;
    if (!st) return;
    const counts = st.unreadCounts || {};
    const hasUnread = Object.values(counts).some(c => c > 0);
    updateTrayBadge(hasUnread);
  }

  // Check every 2 seconds (lightweight, just reads in-memory state)
  setInterval(checkUnreadForBadge, 2000);

  // Expose for onclick handlers and module bridge
  window.configureServer = showAddServerModal;
  window._switchServer = switchServer;
  window._renderServerRail = renderServerRail;
  window._updateAuthServerInfo = updateAuthServerInfo;
})();

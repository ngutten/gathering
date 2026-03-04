// tauri-bridge.js — Tauri-specific overrides (classic script, not a module)
//
// Loaded only when running inside the Tauri webview.
// Provides server URL selection/management UI.

(function() {
  // Tauri v2 exposes __TAURI_INTERNALS__
  if (!window.__TAURI_INTERNALS__) return;

  // Mark for detection by config.js
  window.__TAURI__ = true;

  // ── Server history management ──
  function getServerHistory() {
    try {
      return JSON.parse(localStorage.getItem('gathering_server_history') || '[]');
    } catch { return []; }
  }

  function saveServerHistory(list) {
    localStorage.setItem('gathering_server_history', JSON.stringify(list));
  }

  function addToHistory(url) {
    const history = getServerHistory().filter(u => u !== url);
    history.unshift(url);
    saveServerHistory(history);
  }

  function removeFromHistory(url) {
    saveServerHistory(getServerHistory().filter(u => u !== url));
  }

  function selectServer(url) {
    const cleaned = url.trim().replace(/\/$/, '');
    if (!cleaned) return;
    addToHistory(cleaned);
    localStorage.setItem('gathering_server_url', cleaned);
    location.reload();
  }

  function escapeText(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  // ── Server picker UI ──
  function showServerPicker() {
    const history = getServerHistory();
    const current = localStorage.getItem('gathering_server_url') || '';

    // Hide other screens while picker is shown
    const authScreen = document.getElementById('auth-screen');
    const chatScreen = document.getElementById('chat-screen');
    if (authScreen) authScreen.style.display = 'none';
    if (chatScreen) chatScreen.style.display = 'none';

    // Remove existing picker if any
    const existing = document.getElementById('server-picker');
    if (existing) existing.remove();

    // Create overlay
    const overlay = document.createElement('div');
    overlay.id = 'server-picker';
    overlay.style.cssText = 'display:flex;align-items:center;justify-content:center;width:100%;height:100%;position:fixed;top:0;left:0;z-index:1000;background:var(--bg);';

    const box = document.createElement('div');
    box.style.cssText = 'background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:2rem;width:380px;max-height:80vh;overflow-y:auto;';

    let html = '<h1 style="font-size:1.4rem;margin-bottom:0.3rem;color:var(--accent);">&#x2381; Gathering</h1>';
    html += '<p style="font-size:0.8rem;color:var(--text2);margin-bottom:1.5rem;">Connect to a server</p>';

    // Previous servers
    if (history.length > 0) {
      html += '<div style="margin-bottom:1rem;">';
      html += '<div style="font-size:0.7rem;text-transform:uppercase;color:var(--text2);letter-spacing:0.05em;margin-bottom:0.5rem;">Recent servers</div>';
      history.forEach((url, i) => {
        const isActive = url === current;
        html += '<div style="display:flex;align-items:center;gap:0.5rem;margin-bottom:0.4rem;">';
        html += `<button data-connect="${i}" style="flex:1;text-align:left;padding:0.5rem 0.7rem;background:${isActive ? 'var(--accent2)' : 'var(--bg)'};border:1px solid ${isActive ? 'var(--accent2)' : 'var(--border)'};border-radius:4px;color:${isActive ? '#fff' : 'var(--text)'};font-family:inherit;font-size:0.85rem;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeText(url)}</button>`;
        html += `<button data-delete="${i}" title="Forget" style="padding:0.3rem 0.5rem;background:none;border:1px solid var(--border);border-radius:4px;color:var(--red);cursor:pointer;font-size:0.85rem;line-height:1;font-family:inherit;">&times;</button>`;
        html += '</div>';
      });
      html += '</div>';
    }

    // New server input
    html += '<div style="border-top:1px solid var(--border);padding-top:1rem;">';
    html += '<div style="font-size:0.7rem;text-transform:uppercase;color:var(--text2);letter-spacing:0.05em;margin-bottom:0.5rem;">New server</div>';
    html += '<div style="display:flex;gap:0.5rem;">';
    html += '<input id="new-server-url" type="text" placeholder="https://gather.example.com" style="flex:1;padding:0.5rem 0.7rem;background:var(--bg);border:1px solid var(--border);border-radius:4px;color:var(--text);font-family:inherit;font-size:0.85rem;">';
    html += '<button id="connect-new-btn" style="padding:0.5rem 1rem;background:var(--accent2);color:#fff;border:none;border-radius:4px;cursor:pointer;font-family:inherit;font-size:0.85rem;">Connect</button>';
    html += '</div></div>';

    // Cancel button (only if a server is already configured)
    if (current) {
      html += '<div style="margin-top:1rem;text-align:center;">';
      html += '<button id="picker-cancel-btn" style="padding:0.4rem 1rem;background:var(--bg3);color:var(--text2);border:1px solid var(--border);border-radius:4px;cursor:pointer;font-family:inherit;font-size:0.8rem;">Cancel</button>';
      html += '</div>';
    }

    box.innerHTML = html;
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    // Wire up events
    box.querySelectorAll('[data-connect]').forEach(btn => {
      btn.addEventListener('click', () => {
        selectServer(history[parseInt(btn.dataset.connect)]);
      });
    });

    box.querySelectorAll('[data-delete]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const url = history[parseInt(btn.dataset.delete)];
        removeFromHistory(url);
        if (localStorage.getItem('gathering_server_url') === url) {
          localStorage.removeItem('gathering_server_url');
        }
        // Re-render picker
        showServerPicker();
      });
    });

    const connectNewBtn = document.getElementById('connect-new-btn');
    const newUrlInput = document.getElementById('new-server-url');
    connectNewBtn.addEventListener('click', () => {
      const url = newUrlInput.value.trim();
      if (url) selectServer(url);
    });
    newUrlInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const url = newUrlInput.value.trim();
        if (url) selectServer(url);
      }
    });

    // Cancel button
    const cancelBtn = document.getElementById('picker-cancel-btn');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', () => {
        overlay.remove();
        // Restore whichever screen was visible
        if (chatScreen && chatScreen.style.display === 'block') {
          chatScreen.style.display = 'block';
        } else if (authScreen) {
          authScreen.style.display = 'flex';
        }
      });
    }

    newUrlInput.focus();
  }

  // ── Inject "Change Server" buttons into the UI ──
  function injectServerButtons() {
    // Auth screen: add link below auth buttons
    const authBox = document.querySelector('.auth-box');
    if (authBox && !document.getElementById('auth-change-server')) {
      const current = localStorage.getItem('gathering_server_url');
      const div = document.createElement('div');
      div.id = 'auth-change-server';
      div.style.cssText = 'margin-top:1rem;text-align:center;';
      div.innerHTML = (current
        ? '<div style="font-size:0.7rem;color:var(--text2);margin-bottom:0.3rem;">Server: <code style="color:var(--accent);font-size:0.7rem;">' + escapeText(current) + '</code></div>'
        : '') +
        '<button onclick="configureServer()" style="padding:0.3rem 0.7rem;background:var(--bg3);border:1px solid var(--border);border-radius:4px;color:var(--text2);cursor:pointer;font-family:inherit;font-size:0.75rem;">Change Server</button>';
      authBox.appendChild(div);
    }

    // Sidebar: add to sidebar-bottom
    const sidebarBottom = document.querySelector('.sidebar-bottom');
    if (sidebarBottom && !document.getElementById('sidebar-change-server')) {
      const btn = document.createElement('div');
      btn.id = 'sidebar-change-server';
      btn.style.cssText = 'margin-top:0.4rem;';
      const current = localStorage.getItem('gathering_server_url') || '';
      btn.innerHTML = '<button onclick="configureServer()" style="padding:0.15rem 0.4rem;background:var(--bg3);border:1px solid var(--border);border-radius:3px;color:var(--text2);cursor:pointer;font-family:inherit;font-size:0.65rem;">Change Server</button>';
      sidebarBottom.appendChild(btn);
    }
  }

  // ── Initialization ──
  const serverUrl = localStorage.getItem('gathering_server_url');
  if (!serverUrl) {
    // No server configured — show picker on DOMContentLoaded
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', showServerPicker);
    } else {
      showServerPicker();
    }
  }

  // Inject buttons once DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectServerButtons);
  } else {
    injectServerButtons();
  }

  // Expose for onclick handlers
  window.configureServer = showServerPicker;
})();

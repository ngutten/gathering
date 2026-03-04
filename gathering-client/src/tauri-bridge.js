// tauri-bridge.js — Tauri-specific overrides
//
// Loaded only when running inside the Tauri webview.
// Provides native notification support and server URL configuration.

(function() {
  if (!window.__TAURI__) return;

  // ── Native notifications ──
  // Override browser Notification with Tauri's native notifications
  const originalAppendSystem = window.appendSystem;

  // Use Tauri notification plugin for important system messages
  async function showNativeNotification(title, body) {
    try {
      const { sendNotification, isPermissionGranted, requestPermission } = window.__TAURI__.notification;
      let permitted = await isPermissionGranted();
      if (!permitted) {
        const permission = await requestPermission();
        permitted = permission === 'granted';
      }
      if (permitted) {
        sendNotification({ title, body });
      }
    } catch (e) {
      // Fallback silently — notifications are optional
    }
  }

  // Expose for use by the app
  window.showNativeNotification = showNativeNotification;

  // ── Server URL configuration ──
  // Show a settings dialog if no server URL is configured
  function checkServerConfig() {
    const serverUrl = localStorage.getItem('gathering_server_url');
    if (!serverUrl) {
      promptServerUrl();
    }
  }

  function promptServerUrl() {
    const url = prompt(
      'Enter your Gathering server URL:\n\n' +
      'Example: https://gather.example.com\n' +
      '(Leave empty for localhost:3000)',
      localStorage.getItem('gathering_server_url') || 'http://localhost:3000'
    );
    if (url !== null) {
      const cleaned = url.trim().replace(/\/$/, '');
      localStorage.setItem('gathering_server_url', cleaned);
      location.reload();
    }
  }

  // Expose config dialog
  window.configureServer = promptServerUrl;

  // Check on load
  checkServerConfig();
})();

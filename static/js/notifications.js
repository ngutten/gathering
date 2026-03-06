// notifications.js — Toast and system notification display, notification prefs UI

import state from './state.js';
import { send } from './transport.js';
import { escapeHtml } from './render.js';

const TOAST_DURATION_MS = 5000;

export function showNotification(msg, mentionType) {
  const prefKey = mentionType === 'channel' ? 'notify_channel_mention'
    : mentionType === 'server' ? 'notify_server_mention'
    : 'notify_mention';
  const pref = state.notificationPrefs[prefKey] || 'window';

  if (pref === 'none') return;

  const title = `@${msg.author} in #${msg.channel}`;
  const body = msg.content.substring(0, 200);

  if (pref === 'system') {
    showSystemNotification(title, body, msg.channel);
  } else {
    showToast(title, body, msg.channel);
  }
}

function showToast(title, body, channel) {
  const container = document.getElementById('notification-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = 'notification-toast';
  toast.innerHTML = `<div class="notification-toast-title">${escapeHtml(title)}</div>
    <div class="notification-toast-body">${escapeHtml(body)}</div>`;
  toast.onclick = () => {
    toast.remove();
    import('./chat-ui.js').then(m => m.switchChannel(channel));
  };

  container.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('notification-toast-exit');
    setTimeout(() => toast.remove(), 300);
  }, TOAST_DURATION_MS);
}

function showSystemNotification(title, body, channel) {
  if (!('Notification' in window)) {
    showToast(title, body, channel);
    return;
  }
  if (Notification.permission === 'granted') {
    const n = new Notification(title, { body, tag: 'gathering-mention' });
    n.onclick = () => {
      window.focus();
      import('./chat-ui.js').then(m => m.switchChannel(channel));
    };
  } else if (Notification.permission !== 'denied') {
    Notification.requestPermission().then(perm => {
      if (perm === 'granted') showSystemNotification(title, body, channel);
      else showToast(title, body, channel);
    });
  } else {
    showToast(title, body, channel);
  }
}

export function renderNotificationSettings() {
  // Notification settings are now shown in the User Settings panel (chat-ui.js)
  // This function is kept as a no-op for the message handler call
}

export function setNotifPref(key, value) {
  send('SetPreference', { key, value });
}

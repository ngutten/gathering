// widget-api.js -- Base class, registry, and widget panel manager

import state, { serverHas } from '../state.js';
import { send as transportSend } from '../transport.js';

// ── Base class ──

export class WidgetBase {
  constructor(widgetId, channel, container) {
    this.id = widgetId;
    this.channel = channel;
    this.container = container;
    this._stateReceived = false;
  }

  /** Override: called when a WidgetBroadcast arrives for this widget */
  onMessage(fromUser, action, data) {}

  /**
   * Override: return serializable state snapshot for latecomers.
   * Return null if there's no meaningful state to share.
   */
  getState() { return null; }

  /**
   * Override: restore state from another user's snapshot.
   * Called once when first joining an already-active widget.
   */
  setState(data) {}

  /** Send a widget message to the channel */
  send(action, data) {
    transportSend('WidgetMessage', {
      channel: this.channel,
      widget_id: this.id,
      action,
      data,
    });
  }

  /** Override: render initial UI into this.container */
  activate() {}

  /** Override: cleanup */
  deactivate() {}

  /** Override: handle server response (WidgetStateLoaded, WidgetStateSaved) */
  onServerResponse(type, data) {}

  /** Save widget state to server */
  saveToServer(stateData) {
    transportSend('SaveWidgetState', {
      channel: this.channel,
      widget_id: this.id,
      state: stateData,
    });
  }

  /** Load widget state from server */
  loadFromServer() {
    transportSend('LoadWidgetState', {
      channel: this.channel,
      widget_id: this.id,
    });
  }
}

// ── Registry ──

const registry = {};

export function registerWidget(id, name, cls) {
  registry[id] = { name, cls };
}

export function getRegistry() {
  return registry;
}

// ── Active widget instances ──
// channel -> { widgetId -> instance }
const activeWidgets = {};

// ── Presence tracking ──
// channel -> { widgetId -> Set<username> }
const channelPresence = {};

export function getActiveWidgets(channel) {
  return activeWidgets[channel] || {};
}

/** Check if a widget is enabled on this server. */
function isWidgetEnabled(widgetId) {
  // "widgets" in capabilities = all widgets allowed (or old server with no caps)
  if (serverHas('widgets')) return true;
  // Otherwise check for specific "widget:<id>" capability
  return state.serverCapabilities.includes(`widget:${widgetId}`);
}

export function getChannelPresence(channel) {
  return channelPresence[channel] || {};
}

export function activateWidget(channel, widgetId) {
  if (!registry[widgetId] || !isWidgetEnabled(widgetId)) return;
  if (!activeWidgets[channel]) activeWidgets[channel] = {};
  if (activeWidgets[channel][widgetId]) return; // already active

  const panel = document.getElementById('widget-panel');
  const container = document.createElement('div');
  container.className = 'widget-container';
  container.setAttribute('data-widget-id', widgetId);
  panel.appendChild(container);

  const instance = new registry[widgetId].cls(widgetId, channel, container);
  activeWidgets[channel][widgetId] = instance;
  instance.activate();

  // Show the panel
  panel.style.display = '';
  updateWidgetToolbar();

  // Request state from existing users (small delay to let activate() finish)
  setTimeout(() => {
    instance.send('_request_state', {});
  }, 100);

  // Broadcast our updated presence
  broadcastPresence(channel);
}

export function deactivateWidget(channel, widgetId) {
  const channelWidgets = activeWidgets[channel];
  if (!channelWidgets || !channelWidgets[widgetId]) return;

  channelWidgets[widgetId].deactivate();
  channelWidgets[widgetId].container.remove();
  delete channelWidgets[widgetId];

  // Hide panel if no widgets active in this channel
  if (Object.keys(channelWidgets).length === 0) {
    document.getElementById('widget-panel').style.display = 'none';
  }
  updateWidgetToolbar();

  // Broadcast our updated presence
  broadcastPresence(channel);
}

export function toggleWidget(channel, widgetId) {
  const channelWidgets = activeWidgets[channel] || {};
  if (channelWidgets[widgetId]) {
    deactivateWidget(channel, widgetId);
  } else {
    activateWidget(channel, widgetId);
  }
}

// ── Presence broadcasting ──

function broadcastPresence(channel) {
  const channelWidgets = activeWidgets[channel] || {};
  const activeIds = Object.keys(channelWidgets);
  transportSend('WidgetMessage', {
    channel,
    widget_id: '_meta',
    action: 'presence',
    data: { widgets: activeIds },
  });
}

function handlePresence(channel, fromUser, data) {
  if (!channelPresence[channel]) channelPresence[channel] = {};
  const presence = channelPresence[channel];

  // Clear this user from all widget presence in this channel
  for (const set of Object.values(presence)) {
    set.delete(fromUser);
  }

  // Add them to the widgets they have active
  for (const widgetId of (data.widgets || [])) {
    if (!presence[widgetId]) presence[widgetId] = new Set();
    presence[widgetId].add(fromUser);
  }

  // Clean up empty sets
  for (const [wid, set] of Object.entries(presence)) {
    if (set.size === 0) delete presence[wid];
  }

  updateWidgetToolbar();
  // Re-render picker if visible
  if (pickerVisible) renderWidgetPicker();
}

/** Remove a user from all widget presence in a channel (e.g., when they leave) */
export function clearUserPresence(channel, username) {
  const presence = channelPresence[channel];
  if (!presence) return;
  for (const [wid, set] of Object.entries(presence)) {
    set.delete(username);
    if (set.size === 0) delete presence[wid];
  }
  updateWidgetToolbar();
  if (pickerVisible) renderWidgetPicker();
}

/** Route a server response (WidgetStateLoaded/WidgetStateSaved) to the right widget */
export function routeWidgetServerResponse(msg) {
  const channel = msg.channel;
  const widgetId = msg.widget_id;
  const channelWidgets = activeWidgets[channel];
  if (!channelWidgets) return;
  const instance = channelWidgets[widgetId];
  if (!instance) return;
  instance.onServerResponse(msg.type, msg);
}

/** Route an incoming WidgetBroadcast to the right widget instance */
export function routeWidgetBroadcast(msg) {
  // Handle meta messages (presence)
  if (msg.widget_id === '_meta') {
    if (msg.action === 'presence') {
      handlePresence(msg.channel, msg.from_user, msg.data);
    } else if (msg.action === 'request_presence') {
      // Someone new wants to know what's active — send our presence
      broadcastPresence(msg.channel);
    }
    return;
  }

  const channelWidgets = activeWidgets[msg.channel];
  if (!channelWidgets) return;
  const instance = channelWidgets[msg.widget_id];
  if (!instance) return;

  // Handle framework-level state sync actions
  if (msg.action === '_request_state') {
    // Someone just opened this widget and wants our state
    if (msg.from_user === state.currentUser) return; // don't answer our own request
    const snapshot = instance.getState();
    if (snapshot !== null) {
      instance.send('_provide_state', snapshot);
    }
    return;
  }

  if (msg.action === '_provide_state') {
    // Someone is sharing their state with us
    if (msg.from_user === state.currentUser) return;
    if (!instance._stateReceived) {
      instance._stateReceived = true;
      instance.setState(msg.data);
    }
    return;
  }

  // Normal widget message
  instance.onMessage(msg.from_user, msg.action, msg.data);
}

/** Called when switching channels: hide/show appropriate widgets */
export function onChannelSwitch(newChannel) {
  const panel = document.getElementById('widget-panel');
  // Remove current widget containers from DOM
  panel.innerHTML = '';

  const channelWidgets = activeWidgets[newChannel];
  if (channelWidgets && Object.keys(channelWidgets).length > 0) {
    for (const instance of Object.values(channelWidgets)) {
      panel.appendChild(instance.container);
    }
    panel.style.display = '';
  } else {
    panel.style.display = 'none';
  }
  updateWidgetToolbar();

  // Skip widget presence on encrypted channels (server rejects them)
  if (state.encryptedChannels.has(newChannel)) return;

  // Request presence from other users in this channel
  transportSend('WidgetMessage', {
    channel: newChannel,
    widget_id: '_meta',
    action: 'request_presence',
    data: {},
  });
}

// ── Widget picker UI ──

let pickerVisible = false;

export function toggleWidgetPicker() {
  if (state.encryptedChannels.has(state.currentChannel)) return;
  const picker = document.getElementById('widget-picker');
  pickerVisible = !pickerVisible;
  if (pickerVisible) {
    renderWidgetPicker();
    picker.style.display = 'block';
  } else {
    picker.style.display = 'none';
  }
}

function renderWidgetPicker() {
  const picker = document.getElementById('widget-picker');
  const channel = state.currentChannel;
  const channelWidgets = activeWidgets[channel] || {};
  const presence = channelPresence[channel] || {};

  let html = '';
  for (const [id, info] of Object.entries(registry)) {
    if (!isWidgetEnabled(id)) continue;
    const localActive = !!channelWidgets[id];
    const remoteUsers = presence[id] ? [...presence[id]].filter(u => u !== state.currentUser) : [];
    const hasRemote = remoteUsers.length > 0;
    const classes = ['widget-picker-item'];
    if (localActive) classes.push('active');
    if (hasRemote && !localActive) classes.push('in-use');

    let statusHtml = '';
    if (localActive) {
      statusHtml = '<span class="widget-picker-status">ON</span>';
    } else if (hasRemote) {
      const names = remoteUsers.slice(0, 3).join(', ') + (remoteUsers.length > 3 ? '...' : '');
      statusHtml = `<span class="widget-picker-in-use" title="${names}">${remoteUsers.length} active</span>`;
    }

    html += `<div class="${classes.join(' ')}" onclick="toggleWidget('${id}')">
      <span>${info.name}</span>
      ${statusHtml}
    </div>`;
  }
  if (!html) {
    html = '<div class="widget-picker-empty">No widgets available</div>';
  }
  picker.innerHTML = html;
}

function updateWidgetToolbar() {
  const channel = state.currentChannel;
  const channelWidgets = activeWidgets[channel] || {};
  const presence = channelPresence[channel] || {};
  const localCount = Object.keys(channelWidgets).length;

  // Count remote widget usage (other users, any widget)
  const remoteWidgetIds = new Set();
  for (const [wid, users] of Object.entries(presence)) {
    for (const u of users) {
      if (u !== state.currentUser) { remoteWidgetIds.add(wid); break; }
    }
  }

  const btn = document.getElementById('widget-toolbar-btn');
  if (btn) {
    // Hide the button entirely if no widgets are enabled
    const anyEnabled = Object.keys(registry).some(id => isWidgetEnabled(id));
    btn.style.display = anyEnabled ? '' : 'none';

    // Grey out on encrypted channels
    const encrypted = state.encryptedChannels.has(channel);
    btn.classList.toggle('disabled', encrypted);
    btn.style.opacity = encrypted ? '0.35' : '';
    btn.style.pointerEvents = encrypted ? 'none' : '';
    btn.title = encrypted ? 'Widgets are not available on encrypted channels' : '';

    btn.classList.toggle('active', !encrypted && localCount > 0);
    btn.classList.toggle('in-use', !encrypted && remoteWidgetIds.size > 0 && localCount === 0);

    // Show badge with count of remotely-active widgets
    let badge = btn.querySelector('.widget-badge');
    if (remoteWidgetIds.size > 0) {
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'widget-badge';
        btn.appendChild(badge);
      }
      badge.textContent = remoteWidgetIds.size;
    } else if (badge) {
      badge.remove();
    }
  }
}

// Close picker when clicking outside
document.addEventListener('click', (e) => {
  if (!pickerVisible) return;
  const picker = document.getElementById('widget-picker');
  const btn = document.getElementById('widget-toolbar-btn');
  if (!picker.contains(e.target) && e.target !== btn) {
    pickerVisible = false;
    picker.style.display = 'none';
  }
});

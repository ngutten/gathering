// initiative.js -- Shared initiative tracker widget

import { WidgetBase, registerWidget } from './widget-api.js';
import { escapeHtml } from '../render.js';
import state from '../state.js';

class InitiativeTracker extends WidgetBase {
  activate() {
    this.entries = []; // { name, roll, id }
    this.activeIndex = -1;
    this.render();
  }

  render() {
    const sorted = [...this.entries].sort((a, b) => b.roll - a.roll);
    const rows = sorted.map((e, i) => {
      const active = i === this.activeIndex ? ' initiative-active' : '';
      return `<div class="initiative-row${active}">
        <span class="initiative-roll">${e.roll}</span>
        <span class="initiative-name">${escapeHtml(e.name)}</span>
        <button class="initiative-remove" onclick="initiativeRemove('${this.channel}','${e.id}')">&times;</button>
      </div>`;
    }).join('');

    this.container.innerHTML = `
      <div class="widget-header">
        <span class="widget-title">Initiative Tracker</span>
        <button class="widget-close" onclick="deactivateCurrentWidget('${this.id}')">&times;</button>
      </div>
      <div class="initiative-tracker">
        <div class="initiative-list">${rows || '<div class="initiative-empty">No entries</div>'}</div>
        <div class="initiative-controls">
          <input type="text" class="initiative-name-input" id="init-name-${this.channel}"
                 placeholder="Name" value="${escapeHtml(state.currentUser)}">
          <input type="number" class="initiative-roll-input" id="init-roll-${this.channel}"
                 placeholder="Roll"
                 onkeydown="if(event.key==='Enter')initiativeAdd('${this.channel}')">
          <button class="admin-btn-sm" onclick="initiativeAdd('${this.channel}')">Add</button>
        </div>
        <div class="initiative-actions">
          <button class="admin-btn-sm" onclick="initiativeNext('${this.channel}')">Next Turn</button>
          <button class="admin-btn-sm danger" onclick="initiativeClear('${this.channel}')">Clear</button>
        </div>
      </div>`;
  }

  getState() {
    if (this.entries.length === 0) return null;
    return { entries: this.entries, activeIndex: this.activeIndex };
  }

  setState(data) {
    this.entries = data.entries || [];
    this.activeIndex = data.activeIndex ?? -1;
    this.render();
  }

  onMessage(fromUser, action, data) {
    switch (action) {
      case 'add':
        this.entries.push({ name: data.name, roll: data.roll, id: data.id });
        this.render();
        break;
      case 'remove':
        this.entries = this.entries.filter(e => e.id !== data.id);
        if (this.activeIndex >= this.entries.length) this.activeIndex = -1;
        this.render();
        break;
      case 'next':
        if (this.entries.length > 0) {
          this.activeIndex = (this.activeIndex + 1) % this.entries.length;
        }
        this.render();
        break;
      case 'clear':
        this.entries = [];
        this.activeIndex = -1;
        this.render();
        break;
      case 'sync':
        this.entries = data.entries || [];
        this.activeIndex = data.activeIndex ?? -1;
        this.render();
        break;
    }
  }

  deactivate() {
    this.container.innerHTML = '';
  }
}

export function initiativeAdd(channel) {
  const nameEl = document.getElementById(`init-name-${channel}`);
  const rollEl = document.getElementById(`init-roll-${channel}`);
  if (!nameEl || !rollEl) return;
  const name = nameEl.value.trim();
  const roll = parseInt(rollEl.value, 10);
  if (!name || isNaN(roll)) return;

  window._widgetTransport.send('WidgetMessage', {
    channel,
    widget_id: 'initiative',
    action: 'add',
    data: { name, roll, id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6) },
  });
  rollEl.value = '';
}

export function initiativeRemove(channel, id) {
  window._widgetTransport.send('WidgetMessage', {
    channel,
    widget_id: 'initiative',
    action: 'remove',
    data: { id },
  });
}

export function initiativeNext(channel) {
  window._widgetTransport.send('WidgetMessage', {
    channel,
    widget_id: 'initiative',
    action: 'next',
    data: {},
  });
}

export function initiativeClear(channel) {
  window._widgetTransport.send('WidgetMessage', {
    channel,
    widget_id: 'initiative',
    action: 'clear',
    data: {},
  });
}

registerWidget('initiative', 'Initiative Tracker', InitiativeTracker);

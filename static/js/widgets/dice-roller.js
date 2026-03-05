// dice-roller.js -- Shared dice roller widget

import { WidgetBase, registerWidget } from './widget-api.js';
import { escapeHtml } from '../render.js';

const MAX_ROLL_HISTORY = 50;

class DiceRoller extends WidgetBase {
  activate() {
    this.rollHistory = []; // [{user, data}]
    this.container.innerHTML = `
      <div class="widget-header">
        <span class="widget-title">Dice Roller</span>
        <button class="widget-close" onclick="deactivateCurrentWidget('${this.id}')">&times;</button>
      </div>
      <div class="dice-roller">
        <div class="dice-log" id="dice-log-${this.channel}"></div>
        <div class="dice-controls">
          <input type="text" class="dice-input" id="dice-input-${this.channel}"
                 placeholder="2d6+3, d20, 4d8..."
                 onkeydown="if(event.key==='Enter')diceRoll('${this.channel}')">
          <div class="dice-quick">
            <button onclick="diceRollQuick('${this.channel}','1d4')">d4</button>
            <button onclick="diceRollQuick('${this.channel}','1d6')">d6</button>
            <button onclick="diceRollQuick('${this.channel}','1d8')">d8</button>
            <button onclick="diceRollQuick('${this.channel}','1d10')">d10</button>
            <button onclick="diceRollQuick('${this.channel}','1d12')">d12</button>
            <button onclick="diceRollQuick('${this.channel}','1d20')">d20</button>
            <button onclick="diceRollQuick('${this.channel}','1d100')">d100</button>
          </div>
          <button class="dice-roll-btn" onclick="diceRoll('${this.channel}')">Roll</button>
        </div>
      </div>`;
  }

  getState() {
    if (this.rollHistory.length === 0) return null;
    return { rollHistory: this.rollHistory };
  }

  setState(data) {
    this.rollHistory = data.rollHistory || [];
    // Replay the history into the log
    for (const entry of this.rollHistory) {
      this.appendResult(entry.user, entry.data);
    }
  }

  onMessage(fromUser, action, data) {
    if (action === 'roll') {
      this.rollHistory.push({ user: fromUser, data });
      if (this.rollHistory.length > MAX_ROLL_HISTORY) {
        this.rollHistory.shift();
      }
      this.appendResult(fromUser, data);
    }
  }

  appendResult(user, data) {
    const log = document.getElementById(`dice-log-${this.channel}`);
    if (!log) return;

    const entry = document.createElement('div');
    entry.className = 'dice-entry';

    const rolls = data.rolls.map(r =>
      `<span class="dice-die">${r}</span>`
    ).join(' ');

    entry.innerHTML = `<span class="dice-user">${escapeHtml(user)}</span> `
      + `rolled <span class="dice-expr">${escapeHtml(data.expression)}</span>: `
      + `${rolls}`
      + (data.modifier ? ` <span class="dice-mod">${data.modifier > 0 ? '+' : ''}${data.modifier}</span>` : '')
      + ` = <span class="dice-total">${data.total}</span>`;

    log.appendChild(entry);
    log.scrollTop = log.scrollHeight;
  }

  deactivate() {
    this.container.innerHTML = '';
  }
}

// Parse dice notation: "2d6+3", "d20", "4d8-1"
function parseDice(expr) {
  expr = expr.trim().toLowerCase();
  const match = expr.match(/^(\d*)d(\d+)\s*([+-]\s*\d+)?$/);
  if (!match) return null;
  const count = parseInt(match[1] || '1', 10);
  const sides = parseInt(match[2], 10);
  const modifier = match[3] ? parseInt(match[3].replace(/\s/g, ''), 10) : 0;
  if (count < 1 || count > 100 || sides < 2 || sides > 1000) return null;
  return { count, sides, modifier };
}

function rollDice(parsed) {
  const rolls = [];
  for (let i = 0; i < parsed.count; i++) {
    rolls.push(Math.floor(Math.random() * parsed.sides) + 1);
  }
  const sum = rolls.reduce((a, b) => a + b, 0);
  return { rolls, total: sum + parsed.modifier };
}

// Exported for window bindings
export function diceRoll(channel) {
  const input = document.getElementById(`dice-input-${channel}`);
  if (!input) return;
  const expr = input.value.trim();
  if (!expr) return;

  const parsed = parseDice(expr);
  if (!parsed) return; // silently ignore invalid

  const result = rollDice(parsed);
  // Send via widget message — broadcast will come back to us too
  const { send: transportSend } = window._widgetTransport;
  transportSend('WidgetMessage', {
    channel,
    widget_id: 'dice-roller',
    action: 'roll',
    data: {
      expression: expr,
      rolls: result.rolls,
      modifier: parsed.modifier,
      total: result.total,
    },
  });
  input.value = '';
}

export function diceRollQuick(channel, expr) {
  const parsed = parseDice(expr);
  if (!parsed) return;
  const result = rollDice(parsed);
  const { send: transportSend } = window._widgetTransport;
  transportSend('WidgetMessage', {
    channel,
    widget_id: 'dice-roller',
    action: 'roll',
    data: {
      expression: expr,
      rolls: result.rolls,
      modifier: parsed.modifier,
      total: result.total,
    },
  });
}

registerWidget('dice-roller', 'Dice Roller', DiceRoller);

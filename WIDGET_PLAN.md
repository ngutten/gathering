# Widget / Sub-App Architecture Plan

## Core Concept

Widgets are sandboxed mini-applications that communicate through the existing WebSocket protocol via a generic message type, with isolated state and rendering surface. Examples: whiteboard, dice roller, initiative tracker, shared radio, games.

## Protocol Extension

Add a catch-all message pair to `protocol.rs`:

```rust
// Client → Server
WidgetMessage {
    channel: String,
    widget_id: String,       // e.g. "dice-roller", "whiteboard"
    action: String,          // widget-defined action name
    data: serde_json::Value, // arbitrary payload
}

// Server → Client
WidgetBroadcast {
    channel: String,
    widget_id: String,
    from_user: String,
    action: String,
    data: serde_json::Value,
}
```

The server treats widget messages as **opaque broadcasts** to channel members — it doesn't interpret `action` or `data`. This keeps widget logic entirely client-side.

## Server-Side Changes (Minimal)

1. A new `WidgetMessage` arm in `handle_message` that validates auth + channel membership, then broadcasts a `WidgetBroadcast` to all channel members
2. Optionally, a `widget_state` table for persistence (`channel, widget_id, state_json, updated_at`) with GET/PUT endpoints — widgets that need persistence (initiative tracker) can use this; stateless widgets (dice roller) skip it

No widget-specific logic on the backend.

## Frontend Widget Interface

```javascript
// static/js/widgets/widget-api.js
class WidgetBase {
    constructor(channel, container) {
        this.channel = channel;
        this.container = container;  // DOM element to render into
    }

    // Called when this widget receives a broadcast from another user
    onMessage(fromUser, action, data) { /* override */ }

    // Send a message to other users in the channel
    send(action, data) {
        transport.send({
            type: 'WidgetMessage',
            channel: this.channel,
            widget_id: this.id,
            action,
            data
        });
    }

    // Lifecycle
    activate() { /* render initial UI into this.container */ }
    deactivate() { /* cleanup */ }
}
```

## File Structure

```
static/js/widgets/
├── widget-api.js        # Base class + registry
├── dice-roller.js       # export class DiceRoller extends WidgetBase
├── initiative.js        # export class InitiativeTracker extends WidgetBase
├── whiteboard.js        # export class Whiteboard extends WidgetBase
├── radio.js             # export class SharedRadio extends WidgetBase
└── ...
```

## Widget Registry & Activation

```javascript
const registry = {
    'dice-roller': { name: 'Dice Roller', cls: DiceRoller },
    'initiative':  { name: 'Initiative Tracker', cls: InitiativeTracker },
};

let activeWidgets = {};  // channel → { widgetId → instance }

function activateWidget(channel, widgetId) {
    const container = document.getElementById('widget-panel');
    const instance = new registry[widgetId].cls(channel, container);
    instance.activate();
    activeWidgets[channel] = activeWidgets[channel] || {};
    activeWidgets[channel][widgetId] = instance;
}
```

## UI Integration

Add a **widget panel** — a collapsible area above or beside the message list. Users activate widgets via a toolbar button or `/widget` command. The widget renders into its isolated container `div`.

## Isolation Boundaries

| Concern | Widget can access | Widget cannot access |
|---------|-------------------|---------------------|
| DOM | Its own `container` element only | Message list, sidebar, other widgets |
| State | `state.currentChannel`, `state.username` | `state.token`, internal state, other module internals |
| Network | `this.send()` (widget messages only) | Raw WebSocket, HTTP endpoints |
| Storage | `localStorage` under `widget:{id}:` namespace | Auth tokens, encryption keys |

## Prerequisites from Cleanup Plan

- **O1 (decompose hub.rs)** — creates clean place to add `WidgetMessage` handler
- **O3 (auth/permission helper)** — widget handler gets auth checking for free
- **S7 (channel membership checks)** — widgets must only broadcast to channel members
- **O9 (circular dependency cleanup)** and **O10 (state consolidation)** — establish clean module boundaries

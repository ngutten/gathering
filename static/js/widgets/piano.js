// piano.js -- Collaborative MIDI piano widget
// Thin keyboard bar at the bottom with notes that rise upward and fade.

import { WidgetBase, registerWidget } from './widget-api.js';
import { escapeHtml } from '../render.js';

const FIRST_NOTE = 48; // C3
const LAST_NOTE = 83;  // B5
const TOTAL_KEYS = LAST_NOTE - FIRST_NOTE + 1;
const NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];

function isBlack(midi) {
  return [1,3,6,8,10].includes(midi % 12);
}

function noteName(midi) {
  return NOTE_NAMES[midi % 12] + (Math.floor(midi / 12) - 1);
}

function midiToFreq(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

// ── Simple piano synth using Web Audio ──

class PianoSynth {
  constructor() {
    this.ctx = null;
    this.voices = {};
    this.masterGain = null;
  }

  ensureContext() {
    if (this.ctx) return;
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = 0.3;
    this.masterGain.connect(this.ctx.destination);
  }

  noteOn(midi, velocity = 100) {
    this.ensureContext();
    if (this.voices[midi]) this.noteOff(midi);

    const freq = midiToFreq(midi);
    const t = this.ctx.currentTime;
    const vel = velocity / 127;

    const osc1 = this.ctx.createOscillator();
    const osc2 = this.ctx.createOscillator();
    osc1.type = 'triangle';
    osc2.type = 'sine';
    osc1.frequency.value = freq;
    osc2.frequency.value = freq * 2;
    osc2.detune.value = 3;

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(vel * 0.6, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(vel * 0.3, t + 0.3);

    const harmGain = this.ctx.createGain();
    harmGain.gain.value = 0.15;

    osc1.connect(gain);
    osc2.connect(harmGain);
    harmGain.connect(gain);
    gain.connect(this.masterGain);

    osc1.start(t);
    osc2.start(t);

    this.voices[midi] = { osc1, osc2, gain, harmGain };
  }

  noteOff(midi) {
    const v = this.voices[midi];
    if (!v) return;
    const t = this.ctx.currentTime;
    v.gain.gain.cancelScheduledValues(t);
    v.gain.gain.setValueAtTime(v.gain.gain.value, t);
    v.gain.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
    setTimeout(() => {
      try { v.osc1.stop(); } catch(e) {}
      try { v.osc2.stop(); } catch(e) {}
      try { v.gain.disconnect(); } catch(e) {}
      try { v.harmGain.disconnect(); } catch(e) {}
    }, 350);
    delete this.voices[midi];
  }

  allOff() {
    for (const midi of Object.keys(this.voices)) this.noteOff(Number(midi));
  }
}

// ── Rising note trail ──
// Leading edge rises fast from the keyboard. While held, the trail stretches
// from the keyboard to the head and stays solid. On release the tail detaches
// and also rises; the trail fades out while the whole thing scrolls off the top.

class NoteTrail {
  constructor(midi, color, velocity) {
    this.midi = midi;
    this.color = color;
    this.velocity = velocity / 127;
    this.headY = 0;        // leading edge distance from keyboard (rises always)
    this.tailY = 0;        // bottom edge (0 = keyboard while held, rises on release)
    this.held = true;
    this.tailOpacity = 1;  // trail body fades after release
    this.dead = false;
  }

  release() {
    this.held = false;
  }

  update(dt, canvasH) {
    const speed = 150; // px/s
    this.headY += speed * dt;

    if (!this.held) {
      this.tailY += speed * dt;
      this.tailOpacity = Math.max(0, this.tailOpacity - dt * 2.0);
      // Dead once the tail has scrolled past the canvas
      if (this.tailY * window.devicePixelRatio > canvasH && this.tailOpacity <= 0) {
        this.dead = true;
      }
    }
  }
}

// ── Piano Widget ──

class Piano extends WidgetBase {
  activate() {
    this.synth = new PianoSynth();
    this.midiAccess = null;
    this.midiInputs = [];
    this.userColors = {};
    this.mouseDown = false;
    this.lastMouseNote = null;

    // Particles: active (held) notes keyed by `user:midi`, plus released particles in array
    this.activeParticles = {}; // "user:midi" -> NoteParticle
    this.particles = [];       // released particles still fading
    this.animFrame = null;
    this.lastTime = 0;

    this.container.innerHTML = `
      <div class="widget-header">
        <span class="widget-title">Piano</span>
        <div style="display:flex;align-items:center;gap:0.4rem">
          <button class="piano-midi-btn" onclick="pianoConnectMidi('${this.channel}')">MIDI</button>
          <span class="piano-midi-status" id="piano-midi-status-${this.channel}"></span>
          <button class="widget-close" onclick="deactivateCurrentWidget('${this.id}')">&times;</button>
        </div>
      </div>
      <div class="piano-widget">
        <canvas class="piano-canvas" id="piano-canvas-${this.channel}"></canvas>
        <div class="piano-bar" id="piano-bar-${this.channel}"></div>
      </div>`;

    this.renderKeyboard();
    this.setupMouseEvents();
    this.setupKeyboardEvents();
    this.resizeCanvas();
    this.startAnimation();

    this._resizeHandler = () => this.resizeCanvas();
    window.addEventListener('resize', this._resizeHandler);
  }

  renderKeyboard() {
    const bar = document.getElementById(`piano-bar-${this.channel}`);
    if (!bar) return;
    let html = '';
    for (let midi = FIRST_NOTE; midi <= LAST_NOTE; midi++) {
      const black = isBlack(midi);
      const cls = black ? 'piano-key black' : 'piano-key white';
      const name = noteName(midi);
      html += `<div class="${cls}" data-midi="${midi}" title="${name}">`;
      if (!black && midi % 12 === 0) {
        html += `<span class="piano-key-label">${name}</span>`;
      }
      html += '</div>';
    }
    bar.innerHTML = html;
  }

  resizeCanvas() {
    const canvas = document.getElementById(`piano-canvas-${this.channel}`);
    const bar = document.getElementById(`piano-bar-${this.channel}`);
    if (!canvas || !bar) return;
    // Match canvas width to keyboard bar, height to the canvas CSS height
    const rect = bar.getBoundingClientRect();
    canvas.width = rect.width * window.devicePixelRatio;
    canvas.height = canvas.clientHeight * window.devicePixelRatio;
    canvas.style.width = rect.width + 'px';
    this._noteXCache = null; // invalidate position cache
  }

  // Map a MIDI note to an x position and width on the canvas.
  // Matches the CSS layout: white keys flex-evenly, black keys 14px centered between.
  noteToX(midi, canvasWidth) {
    if (!this._noteXCache || this._noteXCacheW !== canvasWidth) {
      this._noteXCacheW = canvasWidth;
      this._noteXCache = {};
      // Count white keys
      let whiteCount = 0;
      for (let n = FIRST_NOTE; n <= LAST_NOTE; n++) {
        if (!isBlack(n)) whiteCount++;
      }
      const whiteW = canvasWidth / whiteCount;
      let wi = 0;
      for (let n = FIRST_NOTE; n <= LAST_NOTE; n++) {
        if (isBlack(n)) {
          // Black key centered at the boundary between previous and next white key
          const cx = wi * whiteW;
          const bw = whiteW * 0.55;
          this._noteXCache[n] = { x: cx - bw / 2, w: bw };
        } else {
          this._noteXCache[n] = { x: wi * whiteW, w: whiteW };
          wi++;
        }
      }
    }
    return this._noteXCache[midi] || { x: 0, w: 0 };
  }

  startAnimation() {
    this.lastTime = performance.now();
    const loop = (now) => {
      const dt = Math.min((now - this.lastTime) / 1000, 0.1);
      this.lastTime = now;
      this.updateAndDraw(dt);
      this.animFrame = requestAnimationFrame(loop);
    };
    this.animFrame = requestAnimationFrame(loop);
  }

  updateAndDraw(dt) {
    const canvas = document.getElementById(`piano-canvas-${this.channel}`);
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const W = canvas.width;
    const H = canvas.height;
    const dpr = window.devicePixelRatio;

    ctx.clearRect(0, 0, W, H);

    // Update and draw active (held) trails
    for (const t of Object.values(this.activeParticles)) {
      t.update(dt, H);
      this.drawTrail(ctx, t, W, H, dpr);
    }

    // Update and draw released trails
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const t = this.particles[i];
      t.update(dt, H);
      if (t.dead) {
        this.particles.splice(i, 1);
      } else {
        this.drawTrail(ctx, t, W, H, dpr);
      }
    }
  }

  drawTrail(ctx, t, W, H, dpr) {
    const { x, w } = this.noteToX(t.midi, W);
    // Canvas Y: 0=top, H=bottom (keyboard edge)
    // headY/tailY are distances from the keyboard rising upward
    const topEdge = H - t.headY * dpr;   // leading edge (highest point)
    const bottomEdge = H - t.tailY * dpr; // trailing edge

    // Clamp to visible area
    const visTop = Math.max(topEdge, 0);
    const visBottom = Math.min(bottomEdge, H);
    if (visTop >= visBottom) return;

    const drawX = x + 1;
    const drawW = Math.max(w - 2, 2);
    const baseAlpha = 0.5 + t.velocity * 0.5;

    if (t.held) {
      // While held: solid trail, brightest at leading edge (top)
      const grad = ctx.createLinearGradient(0, visTop, 0, visBottom);
      grad.addColorStop(0, t.color);
      const fadedColor = t.color.replace('hsl(', 'hsla(').replace(')', ', 0.4)');
      grad.addColorStop(1, fadedColor);
      ctx.globalAlpha = baseAlpha;
      ctx.fillStyle = grad;
      ctx.fillRect(drawX, visTop, drawW, visBottom - visTop);

      // Bright head glow
      ctx.globalAlpha = baseAlpha * 0.9;
      ctx.fillStyle = '#fff';
      const glowH = Math.min(3 * dpr, visBottom - visTop);
      ctx.fillRect(drawX, visTop, drawW, glowH);
    } else {
      // Released: trail fades, head stays bright, whole thing scrolls up
      const trailH = visBottom - visTop;
      if (trailH <= 0) return;

      // Trail body with fading opacity
      const grad = ctx.createLinearGradient(0, visTop, 0, visBottom);
      grad.addColorStop(0, t.color);
      const fadedColor = t.color.replace('hsl(', 'hsla(').replace(')', `, ${0.3 * t.tailOpacity})`)
      grad.addColorStop(1, fadedColor);
      ctx.globalAlpha = baseAlpha * Math.max(t.tailOpacity, 0.05);
      ctx.fillStyle = grad;
      ctx.fillRect(drawX, visTop, drawW, trailH);

      // Leading edge stays bright even as trail fades
      if (topEdge >= 0) {
        ctx.globalAlpha = baseAlpha * 0.7;
        ctx.fillStyle = t.color;
        const glowH = Math.min(3 * dpr, trailH);
        ctx.fillRect(drawX, visTop, drawW, glowH);
      }
    }

    ctx.globalAlpha = 1;
  }

  // ── Note on/off with particles ──

  spawnNote(midi, user, velocity) {
    const color = this.colorForUser(user);
    const key = `${user}:${midi}`;
    if (this.activeParticles[key]) return; // already held
    this.activeParticles[key] = new NoteTrail(midi, color, velocity);
    this.highlightKey(midi, true, color);
  }

  releaseNote(midi, user) {
    const key = `${user}:${midi}`;
    const p = this.activeParticles[key];
    if (!p) return;
    p.release();
    this.particles.push(p);
    delete this.activeParticles[key];
    this.highlightKey(midi, false);
  }

  highlightKey(midi, on, color) {
    const bar = document.getElementById(`piano-bar-${this.channel}`);
    if (!bar) return;
    const el = bar.querySelector(`[data-midi="${midi}"]`);
    if (!el) return;
    if (on) {
      el.classList.add('active');
      if (color) el.style.setProperty('--active-color', color);
    } else {
      // Only remove if no other user is holding this note
      const stillHeld = Object.keys(this.activeParticles).some(k => k.endsWith(`:${midi}`));
      if (!stillHeld) {
        el.classList.remove('active');
        el.style.removeProperty('--active-color');
      }
    }
  }

  // ── Input handling ──

  setupMouseEvents() {
    const bar = document.getElementById(`piano-bar-${this.channel}`);
    if (!bar) return;

    bar.addEventListener('mousedown', (e) => {
      const key = e.target.closest('.piano-key');
      if (!key) return;
      e.preventDefault();
      this.mouseDown = true;
      const midi = parseInt(key.dataset.midi);
      this.lastMouseNote = midi;
      this.localNoteOn(midi);
    });

    bar.addEventListener('mouseover', (e) => {
      if (!this.mouseDown) return;
      const key = e.target.closest('.piano-key');
      if (!key) return;
      const midi = parseInt(key.dataset.midi);
      if (midi !== this.lastMouseNote) {
        if (this.lastMouseNote !== null) this.localNoteOff(this.lastMouseNote);
        this.lastMouseNote = midi;
        this.localNoteOn(midi);
      }
    });

    const onUp = () => {
      if (this.mouseDown && this.lastMouseNote !== null) {
        this.localNoteOff(this.lastMouseNote);
        this.lastMouseNote = null;
      }
      this.mouseDown = false;
    };
    document.addEventListener('mouseup', onUp);
    this._cleanupMouseUp = onUp;

    bar.addEventListener('touchstart', (e) => {
      const key = e.target.closest('.piano-key');
      if (!key) return;
      e.preventDefault();
      this.localNoteOn(parseInt(key.dataset.midi));
    }, { passive: false });

    bar.addEventListener('touchend', (e) => {
      const key = e.target.closest('.piano-key');
      if (!key) return;
      e.preventDefault();
      this.localNoteOff(parseInt(key.dataset.midi));
    }, { passive: false });
  }

  setupKeyboardEvents() {
    const keyMap = {
      'z': 48, 's': 49, 'x': 50, 'd': 51, 'c': 52, 'v': 53, 'g': 54,
      'b': 55, 'h': 56, 'n': 57, 'j': 58, 'm': 59,
      'q': 60, '2': 61, 'w': 62, '3': 63, 'e': 64, 'r': 65, '5': 66,
      't': 67, '6': 68, 'y': 69, '7': 70, 'u': 71,
      'i': 72, '9': 73, 'o': 74, '0': 75, 'p': 76,
    };
    this._keyboardNotes = new Set();

    this._onKeyDown = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      const midi = keyMap[e.key.toLowerCase()];
      if (midi === undefined) return;
      if (this._keyboardNotes.has(midi)) return;
      e.preventDefault();
      this._keyboardNotes.add(midi);
      this.localNoteOn(midi);
    };

    this._onKeyUp = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      const midi = keyMap[e.key.toLowerCase()];
      if (midi === undefined) return;
      this._keyboardNotes.delete(midi);
      this.localNoteOff(midi);
    };

    document.addEventListener('keydown', this._onKeyDown);
    document.addEventListener('keyup', this._onKeyUp);
  }

  localNoteOn(midi, velocity = 100) {
    this.synth.noteOn(midi, velocity);
    this.send('note_on', { midi, velocity });
    this.spawnNote(midi, '_local', velocity);
  }

  localNoteOff(midi) {
    this.synth.noteOff(midi);
    this.send('note_off', { midi });
    this.releaseNote(midi, '_local');
  }

  onMessage(fromUser, action, data) {
    if (action === 'note_on') {
      this.synth.noteOn(data.midi, data.velocity || 100);
      this.spawnNote(data.midi, fromUser, data.velocity || 100);
    } else if (action === 'note_off') {
      this.synth.noteOff(data.midi);
      this.releaseNote(data.midi, fromUser);
    }
  }

  colorForUser(user) {
    if (user === '_local') return 'hsl(210, 80%, 60%)';
    if (this.userColors[user]) return this.userColors[user];
    let hash = 0;
    for (let i = 0; i < user.length; i++) {
      hash = ((hash << 5) - hash + user.charCodeAt(i)) | 0;
    }
    const hue = ((hash % 360) + 360) % 360;
    this.userColors[user] = `hsl(${hue}, 70%, 55%)`;
    return this.userColors[user];
  }

  // ── MIDI ──

  connectMidi() {
    const statusEl = document.getElementById(`piano-midi-status-${this.channel}`);
    if (!navigator.requestMIDIAccess) {
      if (statusEl) statusEl.textContent = 'Not supported';
      return;
    }
    navigator.requestMIDIAccess().then((access) => {
      this.midiAccess = access;
      this.bindMidiInputs();
      access.onstatechange = () => this.bindMidiInputs();
    }).catch(() => {
      if (statusEl) statusEl.textContent = 'Denied';
    });
  }

  bindMidiInputs() {
    for (const input of this.midiInputs) input.onmidimessage = null;
    this.midiInputs = [];
    if (!this.midiAccess) return;
    for (const input of this.midiAccess.inputs.values()) {
      input.onmidimessage = (e) => this.handleMidiMessage(e);
      this.midiInputs.push(input);
    }
    const statusEl = document.getElementById(`piano-midi-status-${this.channel}`);
    if (statusEl) {
      const n = this.midiInputs.length;
      statusEl.textContent = n > 0 ? `${n} device${n > 1 ? 's' : ''}` : 'No devices';
    }
  }

  handleMidiMessage(e) {
    const [status, note, velocity] = e.data;
    const cmd = status & 0xf0;
    if (cmd === 0x90 && velocity > 0) {
      if (note >= 21 && note <= 108) this.localNoteOn(note, velocity);
    } else if (cmd === 0x80 || (cmd === 0x90 && velocity === 0)) {
      if (note >= 21 && note <= 108) this.localNoteOff(note);
    }
  }

  deactivate() {
    if (this.animFrame) cancelAnimationFrame(this.animFrame);
    this.synth.allOff();
    for (const input of this.midiInputs) input.onmidimessage = null;
    if (this._onKeyDown) document.removeEventListener('keydown', this._onKeyDown);
    if (this._onKeyUp) document.removeEventListener('keyup', this._onKeyUp);
    if (this._cleanupMouseUp) document.removeEventListener('mouseup', this._cleanupMouseUp);
    if (this._resizeHandler) window.removeEventListener('resize', this._resizeHandler);
    this._keyboardNotes = null;
    this.container.innerHTML = '';
  }
}

export function pianoConnectMidi(channel) {
  const widgets = window._getActiveWidgets(channel);
  const instance = widgets['piano'];
  if (instance) instance.connectMidi();
}

registerWidget('piano', 'Piano', Piano);

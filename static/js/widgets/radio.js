// radio.js -- Shared radio widget with synced playback and music library browser

import { WidgetBase, registerWidget } from './widget-api.js';
import { escapeHtml } from '../render.js';
import { fileUrl, apiUrl } from '../config.js';
import { apiFetch } from '../transport.js';
import state from '../state.js';

const SYNC_INTERVAL_MS = 5000;

class Radio extends WidgetBase {
  activate() {
    this.playlist = [];       // [{name, url, path}]
    this.playlistName = '';
    this.currentIndex = -1;
    this.djUser = null;       // who controls playback
    this.isPlaying = false;
    this.serverTime = 0;      // server-reported position
    this.startedAt = 0;       // Date.now() when sync was received
    this.musicTree = null;    // cached server music tree
    this.topicSources = [];   // [{channel, topicId, title, files:[]}]
    this.volume = parseFloat(localStorage.getItem('widget:radio:volume') || '0.5');
    this.audio = new Audio();
    this.audio.volume = this.volume;
    this.audio.addEventListener('ended', () => this.onTrackEnded());
    this.audio.addEventListener('timeupdate', () => this.updateProgress());
    this.syncTimer = null;
    this.browseExpanded = {};  // path -> bool for tree state
    this.browseMode = 'library'; // 'library' or 'topics'
    this.topicChannel = '';
    this.topicList = [];
    this.topicFiles = null;    // files from selected topic
    this.render();
    this.loadMusicLibrary();
  }

  render() {
    const playing = this.isPlaying && this.currentIndex >= 0;
    const track = playing ? this.playlist[this.currentIndex] : null;
    const isDJ = this.djUser === state.currentUser;
    const hasDJ = !!this.djUser;
    const duration = this.audio.duration || 0;
    const current = this.audio.currentTime || 0;

    this.container.innerHTML = `
      <div class="widget-header">
        <span class="widget-title">Radio</span>
        <span class="radio-dj-badge">${hasDJ ? `DJ: ${escapeHtml(this.djUser)}` : 'No DJ'}</span>
        <button class="widget-close" onclick="deactivateCurrentWidget('${this.id}')">&times;</button>
      </div>
      <div class="radio-widget">
        <div class="radio-now-playing">
          <div class="radio-track-name">${track ? escapeHtml(track.name) : 'Nothing playing'}</div>
          <div class="radio-progress-row">
            <span class="radio-time">${formatTime(current)}</span>
            <div class="radio-progress-bar" onclick="radioSeek(event, '${this.channel}')">
              <div class="radio-progress-fill" style="width:${duration ? (current / duration * 100) : 0}%"></div>
            </div>
            <span class="radio-time">${formatTime(duration)}</span>
          </div>
          <div class="radio-controls">
            ${!hasDJ ? `<button class="admin-btn-sm" onclick="radioBecameDJ('${this.channel}')">Become DJ</button>` : ''}
            ${isDJ ? `<button class="admin-btn-sm" onclick="radioPrev('${this.channel}')">&laquo;</button>` : ''}
            ${isDJ ? `<button class="admin-btn-sm" onclick="radioTogglePlay('${this.channel}')">${this.isPlaying ? 'Pause' : 'Play'}</button>` : ''}
            ${isDJ ? `<button class="admin-btn-sm" onclick="radioNext('${this.channel}')">&raquo;</button>` : ''}
            ${isDJ ? `<button class="admin-btn-sm" onclick="radioStop('${this.channel}')">Stop</button>` : ''}
            ${(hasDJ && !isDJ) ? `<button class="admin-btn-sm" onclick="radioBecameDJ('${this.channel}')">Take over DJ</button>` : ''}
            <div class="radio-volume">
              <span class="radio-vol-icon">&#x1F50A;</span>
              <input type="range" min="0" max="1" step="0.01" value="${this.volume}"
                     oninput="radioSetVolume('${this.channel}', this.value)" class="radio-vol-slider">
            </div>
          </div>
        </div>
        <div class="radio-playlist-section">
          <div class="radio-playlist-header">
            <span>${this.playlistName ? escapeHtml(this.playlistName) : 'Playlist'} (${this.playlist.length})</span>
          </div>
          <div class="radio-playlist">${this.renderPlaylist()}</div>
        </div>
        <div class="radio-browser-section">
          <div class="radio-browser-tabs">
            <button class="${this.browseMode === 'library' ? 'active' : ''}"
                    onclick="radioSwitchBrowse('${this.channel}','library')">Server Library</button>
            <button class="${this.browseMode === 'topics' ? 'active' : ''}"
                    onclick="radioSwitchBrowse('${this.channel}','topics')">Topic Files</button>
          </div>
          <div class="radio-browser">${this.renderBrowser()}</div>
        </div>
      </div>`;
  }

  renderPlaylist() {
    if (this.playlist.length === 0) return '<div class="radio-empty">Empty playlist</div>';
    return this.playlist.map((t, i) => {
      const active = i === this.currentIndex ? ' radio-pl-active' : '';
      return `<div class="radio-pl-item${active}">
        <span class="radio-pl-num">${i + 1}</span>
        <span class="radio-pl-name">${escapeHtml(t.name)}</span>
      </div>`;
    }).join('');
  }

  renderBrowser() {
    if (this.browseMode === 'library') {
      if (!this.musicTree) return '<div class="radio-empty">Loading...</div>';
      if (this.musicTree.length === 0) return '<div class="radio-empty">No music on server. Admin: add files to the music/ directory.</div>';
      return this.renderTree(this.musicTree, '');
    }
    // Topic browse mode
    return this.renderTopicBrowser();
  }

  renderTree(nodes, parentPath) {
    return nodes.map(node => {
      if (node.children) {
        const path = parentPath ? `${parentPath}/${node.name}` : node.name;
        const expanded = this.browseExpanded[path];
        const childCount = countFiles(node);
        return `<div class="radio-tree-dir">
          <div class="radio-tree-row" onclick="radioToggleDir('${this.channel}','${escapePath(path)}')">
            <span class="radio-tree-arrow">${expanded ? '&#x25BE;' : '&#x25B8;'}</span>
            <span class="radio-tree-dir-name">${escapeHtml(node.name)}</span>
            <span class="radio-tree-count">${childCount}</span>
            <button class="radio-tree-play" onclick="event.stopPropagation();radioPlayDir('${this.channel}','${escapePath(path)}')" title="Play all">&#x25B6;</button>
          </div>
          ${expanded ? `<div class="radio-tree-children">${this.renderTree(node.children, path)}</div>` : ''}
        </div>`;
      }
      return `<div class="radio-tree-file">
        <span class="radio-tree-file-name">${escapeHtml(node.name)}</span>
        <span class="radio-tree-file-size">${formatSize(node.size)}</span>
        <button class="radio-tree-play" onclick="radioPlayFile('${this.channel}','music','${escapePath(node.path)}')" title="Play">&#x25B6;</button>
      </div>`;
    }).join('');
  }

  renderTopicBrowser() {
    // Step 1: channel selector
    const channelOpts = (state.channels || [])
      .filter(c => c.channel_type !== 'voice')
      .map(c => `<option value="${escapeHtml(c.name)}" ${c.name === this.topicChannel ? 'selected' : ''}>${escapeHtml(c.name)}</option>`)
      .join('');

    let content = `<div class="radio-topic-picker">
      <select onchange="radioPickTopicChannel('${this.channel}', this.value)" class="radio-topic-select">
        <option value="">Select channel...</option>
        ${channelOpts}
      </select>
    </div>`;

    if (this.topicFiles) {
      // Showing files from a selected topic
      const back = `<div class="radio-topic-back" onclick="radioClearTopicFiles('${this.channel}')">&larr; Back to topics</div>`;
      if (this.topicFiles.length === 0) {
        content += back + '<div class="radio-empty">No audio files in this topic</div>';
      } else {
        const playAll = `<button class="admin-btn-sm" onclick="radioPlayTopicFiles('${this.channel}')" style="margin:0.3rem 0;">Play all (${this.topicFiles.length})</button>`;
        const files = this.topicFiles.map(f =>
          `<div class="radio-tree-file">
            <span class="radio-tree-file-name">${escapeHtml(f.filename)}</span>
            <span class="radio-tree-file-size">${formatSize(f.size)}</span>
            <button class="radio-tree-play" onclick="radioPlayFile('${this.channel}','topic','${f.id}')" title="Play">&#x25B6;</button>
          </div>`
        ).join('');
        content += back + playAll + files;
      }
    } else if (this.topicChannel && this.topicList.length > 0) {
      content += this.topicList.map(t => {
        const audioCount = t._audioCount || 0;
        if (audioCount === 0) return '';
        return `<div class="radio-topic-item" onclick="radioLoadTopicFiles('${this.channel}','${t.id}')">
          <span>${escapeHtml(t.title)}</span>
          <span class="radio-tree-count">${audioCount} audio</span>
        </div>`;
      }).filter(Boolean).join('') || '<div class="radio-empty">No topics with audio files</div>';
    } else if (this.topicChannel) {
      content += '<div class="radio-empty">Loading topics...</div>';
    }

    return content;
  }

  getState() {
    if (!this.djUser && this.playlist.length === 0) return null;
    return {
      playlist: this.playlist,
      playlistName: this.playlistName,
      currentIndex: this.currentIndex,
      position: this.audio.currentTime || 0,
      isPlaying: this.isPlaying,
      djUser: this.djUser,
    };
  }

  setState(data) {
    this.playlist = data.playlist || [];
    this.playlistName = data.playlistName || '';
    this.currentIndex = data.currentIndex ?? -1;
    this.djUser = data.djUser;
    this.isPlaying = data.isPlaying;
    if (this.isPlaying && this.currentIndex >= 0 && this.currentIndex < this.playlist.length) {
      this.loadAndPlay(this.currentIndex);
      if (data.position) this.audio.currentTime = data.position;
    }
    this.render();
  }

  // ── Playback control ──

  loadAndPlay(index) {
    if (index < 0 || index >= this.playlist.length) return;
    this.currentIndex = index;
    const track = this.playlist[index];
    this.audio.src = track.url;
    this.audio.load();
    this.audio.play().catch(() => {});
    this.isPlaying = true;
    this.render();
  }

  onTrackEnded() {
    if (this.djUser !== state.currentUser) return;
    // Auto-advance
    if (this.currentIndex < this.playlist.length - 1) {
      this.currentIndex++;
      this.broadcastPlay();
    } else {
      this.isPlaying = false;
      this.broadcastState();
    }
  }

  updateProgress() {
    const fill = this.container.querySelector('.radio-progress-fill');
    const times = this.container.querySelectorAll('.radio-time');
    if (fill && this.audio.duration) {
      fill.style.width = (this.audio.currentTime / this.audio.duration * 100) + '%';
    }
    if (times.length >= 2) {
      times[0].textContent = formatTime(this.audio.currentTime);
      times[1].textContent = formatTime(this.audio.duration || 0);
    }
  }

  // ── Widget messaging ──

  broadcastPlay() {
    this.loadAndPlay(this.currentIndex);
    this.send('play', {
      playlist: this.playlist,
      playlistName: this.playlistName,
      index: this.currentIndex,
      position: 0,
      djUser: state.currentUser,
    });
    this.startSyncTimer();
  }

  broadcastState() {
    this.send('state', {
      playlist: this.playlist,
      playlistName: this.playlistName,
      index: this.currentIndex,
      position: this.audio.currentTime || 0,
      isPlaying: this.isPlaying,
      djUser: this.djUser,
    });
  }

  broadcastSync() {
    if (this.djUser !== state.currentUser) return;
    this.send('sync', {
      index: this.currentIndex,
      position: this.audio.currentTime || 0,
      isPlaying: this.isPlaying,
    });
  }

  startSyncTimer() {
    this.stopSyncTimer();
    this.syncTimer = setInterval(() => this.broadcastSync(), SYNC_INTERVAL_MS);
  }

  stopSyncTimer() {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
  }

  onMessage(fromUser, action, data) {
    switch (action) {
      case 'play': {
        this.playlist = data.playlist || [];
        this.playlistName = data.playlistName || '';
        this.currentIndex = data.index ?? 0;
        this.djUser = data.djUser;
        this.isPlaying = true;
        if (fromUser !== state.currentUser) {
          this.loadAndPlay(this.currentIndex);
          if (data.position) this.audio.currentTime = data.position;
        }
        this.render();
        break;
      }
      case 'state': {
        this.playlist = data.playlist || [];
        this.playlistName = data.playlistName || '';
        this.currentIndex = data.index ?? -1;
        this.djUser = data.djUser;
        this.isPlaying = data.isPlaying;
        if (fromUser !== state.currentUser) {
          if (this.isPlaying && this.currentIndex >= 0) {
            const track = this.playlist[this.currentIndex];
            if (track && this.audio.src !== track.url) {
              this.audio.src = track.url;
              this.audio.load();
            }
            this.audio.currentTime = data.position || 0;
            if (this.isPlaying) this.audio.play().catch(() => {});
          } else {
            this.audio.pause();
          }
        }
        this.render();
        break;
      }
      case 'sync': {
        if (fromUser === state.currentUser) break;
        // Correct drift
        if (data.index !== this.currentIndex && data.index >= 0 && data.index < this.playlist.length) {
          this.currentIndex = data.index;
          this.loadAndPlay(this.currentIndex);
        }
        if (data.isPlaying && this.audio.paused) {
          this.audio.play().catch(() => {});
        } else if (!data.isPlaying && !this.audio.paused) {
          this.audio.pause();
        }
        this.isPlaying = data.isPlaying;
        // Correct position drift > 2s
        const drift = Math.abs((this.audio.currentTime || 0) - (data.position || 0));
        if (drift > 2) {
          this.audio.currentTime = data.position || 0;
        }
        break;
      }
      case 'pause': {
        this.isPlaying = false;
        if (fromUser !== state.currentUser) this.audio.pause();
        this.render();
        break;
      }
      case 'stop': {
        this.isPlaying = false;
        this.currentIndex = -1;
        this.djUser = null;
        this.playlist = [];
        this.playlistName = '';
        this.audio.pause();
        this.audio.src = '';
        this.stopSyncTimer();
        this.render();
        break;
      }
      case 'dj': {
        this.djUser = data.djUser;
        if (data.djUser === state.currentUser) {
          this.startSyncTimer();
        } else {
          this.stopSyncTimer();
        }
        this.render();
        break;
      }
    }
  }

  // ── Music library loading ──

  async loadMusicLibrary() {
    try {
      const resp = await apiFetch('/api/music');
      if (resp.ok) {
        this.musicTree = await resp.json();
      } else {
        this.musicTree = [];
      }
    } catch {
      this.musicTree = [];
    }
    this.render();
  }

  // ── Collect files from tree ──

  collectFiles(nodes, parentPath) {
    let files = [];
    for (const node of nodes) {
      if (node.children) {
        files = files.concat(this.collectFiles(node.children, parentPath ? `${parentPath}/${node.name}` : node.name));
      } else if (node.path) {
        files.push({
          name: node.name,
          url: fileUrl(`/api/music/${node.path}`),
          path: node.path,
        });
      }
    }
    return files;
  }

  findSubtree(path) {
    const parts = path.split('/');
    let nodes = this.musicTree;
    for (const part of parts) {
      const found = nodes.find(n => n.name === part && n.children);
      if (!found) return null;
      nodes = found.children;
    }
    return nodes;
  }

  deactivate() {
    this.audio.pause();
    this.audio.src = '';
    this.stopSyncTimer();
    this.container.innerHTML = '';
  }
}

// ── Helper functions ──

function formatTime(s) {
  if (!s || !isFinite(s)) return '0:00';
  const mins = Math.floor(s / 60);
  const secs = Math.floor(s % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function formatSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return bytes + 'B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(0) + 'KB';
  return (bytes / 1048576).toFixed(1) + 'MB';
}

function countFiles(node) {
  if (!node.children) return node.path ? 1 : 0;
  return node.children.reduce((sum, c) => sum + countFiles(c), 0);
}

function escapePath(p) {
  return p.replace(/'/g, "\\'").replace(/\\/g, '\\\\');
}

function isAudioMime(mime) {
  return mime && mime.startsWith('audio/');
}

function getRadio(channel) {
  const widgets = window._getActiveWidgets?.(channel);
  return widgets?.['radio'];
}

// ── Window-exposed functions ──

export function radioTogglePlay(channel) {
  const r = getRadio(channel);
  if (!r || r.djUser !== state.currentUser) return;
  if (r.isPlaying) {
    r.isPlaying = false;
    r.audio.pause();
    r.send('pause', {});
    r.stopSyncTimer();
  } else {
    if (r.currentIndex >= 0) {
      r.isPlaying = true;
      r.audio.play().catch(() => {});
      r.broadcastSync();
      r.startSyncTimer();
      r.send('state', {
        playlist: r.playlist,
        playlistName: r.playlistName,
        index: r.currentIndex,
        position: r.audio.currentTime || 0,
        isPlaying: true,
        djUser: r.djUser,
      });
    }
  }
  r.render();
}

export function radioNext(channel) {
  const r = getRadio(channel);
  if (!r || r.djUser !== state.currentUser) return;
  if (r.currentIndex < r.playlist.length - 1) {
    r.currentIndex++;
    r.broadcastPlay();
  }
}

export function radioPrev(channel) {
  const r = getRadio(channel);
  if (!r || r.djUser !== state.currentUser) return;
  // If > 3s into track, restart; otherwise go back
  if (r.audio.currentTime > 3 && r.currentIndex >= 0) {
    r.audio.currentTime = 0;
    r.broadcastSync();
  } else if (r.currentIndex > 0) {
    r.currentIndex--;
    r.broadcastPlay();
  }
}

export function radioStop(channel) {
  const r = getRadio(channel);
  if (!r || r.djUser !== state.currentUser) return;
  r.send('stop', {});
}

export function radioBecameDJ(channel) {
  const r = getRadio(channel);
  if (!r) return;
  r.djUser = state.currentUser;
  r.send('dj', { djUser: state.currentUser });
  r.startSyncTimer();
  r.render();
}

export function radioSetVolume(channel, val) {
  const r = getRadio(channel);
  if (!r) return;
  r.volume = parseFloat(val);
  r.audio.volume = r.volume;
  localStorage.setItem('widget:radio:volume', val);
}

export function radioSeek(event, channel) {
  const r = getRadio(channel);
  if (!r || r.djUser !== state.currentUser) return;
  const bar = event.currentTarget;
  const rect = bar.getBoundingClientRect();
  const pct = (event.clientX - rect.left) / rect.width;
  if (r.audio.duration) {
    r.audio.currentTime = pct * r.audio.duration;
    r.broadcastSync();
  }
}

export function radioToggleDir(channel, path) {
  const r = getRadio(channel);
  if (!r) return;
  r.browseExpanded[path] = !r.browseExpanded[path];
  r.render();
}

export function radioPlayDir(channel, path) {
  const r = getRadio(channel);
  if (!r) return;
  const subtree = r.findSubtree(path);
  if (!subtree) return;
  const files = r.collectFiles(subtree, '');
  if (files.length === 0) return;

  // Become DJ if no one is
  if (!r.djUser) r.djUser = state.currentUser;
  if (r.djUser !== state.currentUser) return;

  r.playlist = files;
  r.playlistName = path.split('/').pop() || path;
  r.currentIndex = 0;
  r.broadcastPlay();
}

export function radioPlayFile(channel, source, pathOrId) {
  const r = getRadio(channel);
  if (!r) return;

  if (!r.djUser) r.djUser = state.currentUser;
  if (r.djUser !== state.currentUser) return;

  let track;
  if (source === 'music') {
    const name = pathOrId.split('/').pop();
    track = { name, url: fileUrl(`/api/music/${pathOrId}`), path: pathOrId };
  } else {
    // topic file
    const f = r.topicFiles?.find(f => f.id === pathOrId);
    if (!f) return;
    track = { name: f.filename, url: fileUrl(`/api/files/${f.id}`), path: f.id };
  }

  r.playlist = [track];
  r.playlistName = '';
  r.currentIndex = 0;
  r.broadcastPlay();
}

export function radioSwitchBrowse(channel, mode) {
  const r = getRadio(channel);
  if (!r) return;
  r.browseMode = mode;
  r.render();
}

export function radioPickTopicChannel(channel, topicChannel) {
  const r = getRadio(channel);
  if (!r) return;
  r.topicChannel = topicChannel;
  r.topicList = [];
  r.topicFiles = null;
  if (!topicChannel) { r.render(); return; }

  // Request topic list for that channel via widget's own WS
  // We'll use a one-shot listener for TopicList
  const handler = (msg) => {
    if (msg.type === 'TopicList' && msg.channel === topicChannel) {
      state._radioTopicHandler = null;
      r.topicList = msg.topics;
      // For each topic, we need to check if it has audio. We'll load each one.
      // But that's expensive. Instead, we fetch details for topics to count audio.
      // For now, just show all topics and let user click to see files.
      r.topicList.forEach(t => { t._audioCount = '?'; });
      r.render();
      // Now fetch details for each to get audio counts
      loadTopicAudioCounts(r, topicChannel);
    }
  };
  state._radioTopicHandler = handler;
  window._widgetTransport.send('ListTopics', { channel: topicChannel, limit: 50 });
  r.render();
}

function loadTopicAudioCounts(radio, topicChannel) {
  // Fetch each topic's detail to count audio attachments
  let pending = radio.topicList.length;
  if (pending === 0) return;

  const detailHandler = (msg) => {
    if (msg.type !== 'TopicDetail') return;
    const t = radio.topicList.find(t => t.id === msg.topic?.id);
    if (t) {
      const audioFiles = (msg.topic.attachments || []).filter(a => isAudioMime(a.mime_type));
      // Also count reply attachments
      for (const reply of (msg.replies || [])) {
        for (const a of (reply.attachments || [])) {
          if (isAudioMime(a.mime_type)) audioFiles.push(a);
        }
      }
      t._audioCount = audioFiles.length;
      t._audioFiles = audioFiles;
    }
    pending--;
    if (pending <= 0) {
      state._radioDetailHandler = null;
    }
    radio.render();
  };
  state._radioDetailHandler = detailHandler;

  for (const t of radio.topicList) {
    window._widgetTransport.send('GetTopic', { topic_id: t.id });
  }
}

export function radioLoadTopicFiles(channel, topicId) {
  const r = getRadio(channel);
  if (!r) return;
  const topic = r.topicList.find(t => t.id === topicId);
  if (!topic || !topic._audioFiles) return;
  r.topicFiles = topic._audioFiles;
  r.render();
}

export function radioClearTopicFiles(channel) {
  const r = getRadio(channel);
  if (!r) return;
  r.topicFiles = null;
  r.render();
}

export function radioPlayTopicFiles(channel) {
  const r = getRadio(channel);
  if (!r || !r.topicFiles || r.topicFiles.length === 0) return;

  if (!r.djUser) r.djUser = state.currentUser;
  if (r.djUser !== state.currentUser) return;

  r.playlist = r.topicFiles.map(f => ({
    name: f.filename,
    url: fileUrl(`/api/files/${f.id}`),
    path: f.id,
  }));
  r.playlistName = 'Topic files';
  r.currentIndex = 0;
  r.broadcastPlay();
}

registerWidget('radio', 'Radio', Radio);

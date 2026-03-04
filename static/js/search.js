// search.js — Hybrid search: server-side for unencrypted, client-side for encrypted

import state from './state.js';
import { send } from './transport.js';
import { escapeHtml, renderRichContent } from './render.js';
import { decryptMessage } from './crypto.js';

export function toggleSearch() {
  state.searchOpen = !state.searchOpen;
  const bar = document.getElementById('search-bar');
  const results = document.getElementById('search-results');
  if (state.searchOpen) {
    bar.style.display = 'flex';
    results.style.display = 'block';
    document.getElementById('search-input').focus();
  } else {
    bar.style.display = 'none';
    results.style.display = 'none';
    results.innerHTML = '';
    state.searchResults = [];
  }
}

export function closeSearch() {
  state.searchOpen = false;
  document.getElementById('search-bar').style.display = 'none';
  document.getElementById('search-results').style.display = 'none';
  document.getElementById('search-results').innerHTML = '';
  state.searchResults = [];
}

export function executeSearch() {
  const query = document.getElementById('search-input').value.trim();
  if (!query) return;

  const ch = state.currentChannel;
  const isEncrypted = state.encryptedChannels.has(ch) && state.channelKeys[ch];

  if (isEncrypted) {
    // Client-side search: request more history, decrypt, filter
    clientSideSearch(query, ch);
  } else {
    // Server-side search
    send('SearchMessages', { query, channel: ch });
  }
}

function clientSideSearch(query, channel) {
  // Request a large history batch
  send('History', { channel, limit: 1000 });
  // Store a pending search to process when history arrives
  state._pendingSearch = { query, channel };
}

export function handleSearchHistory(msg) {
  // Called from messages.js when we get a History response during a search
  if (!state._pendingSearch) return false;
  if (msg.channel !== state._pendingSearch.channel) return false;

  const query = state._pendingSearch.query.toLowerCase();
  const channel = state._pendingSearch.channel;
  state._pendingSearch = null;

  const key = state.channelKeys[channel];
  const results = [];

  for (const m of msg.messages) {
    let content = m.content;
    if (m.encrypted && key) {
      const dec = decryptMessage(m.content, key);
      if (dec !== null) content = dec;
      else continue;
    }
    if (content.toLowerCase().includes(query)) {
      results.push({
        id: m.id,
        channel: channel,
        author: m.author,
        content: content,
        timestamp: m.timestamp,
      });
    }
  }

  renderSearchResults(results, query);
  return true;
}

export function handleSearchResults(msg) {
  renderSearchResults(msg.results, msg.query);
}

function renderSearchResults(results, query) {
  state.searchResults = results;
  const el = document.getElementById('search-results');
  el.style.display = 'block';

  if (results.length === 0) {
    el.innerHTML = '<div class="search-empty">No results found.</div>';
    return;
  }

  el.innerHTML = results.map(r => {
    const time = new Date(r.timestamp).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    // Highlight matching text in snippet
    const snippet = getSnippet(r.content, query);
    return `<div class="search-result" onclick="scrollToMessage('${r.id}')">
      <div class="search-result-meta">
        <span class="author">${escapeHtml(r.author)}</span>
        <span class="time">${time}</span>
        <span class="search-channel">#${escapeHtml(r.channel)}</span>
      </div>
      <div class="search-result-content">${snippet}</div>
    </div>`;
  }).join('');
}

function getSnippet(content, query) {
  const escaped = escapeHtml(content);
  if (!query) return escaped;
  // Highlight query in escaped content (case-insensitive)
  const re = new RegExp('(' + escapeRegex(escapeHtml(query)) + ')', 'gi');
  let result = escaped.replace(re, '<mark>$1</mark>');
  // Truncate if too long
  if (result.length > 200) {
    const idx = result.toLowerCase().indexOf(query.toLowerCase());
    const start = Math.max(0, idx - 60);
    result = (start > 0 ? '...' : '') + result.substring(start, start + 200) + '...';
  }
  return result;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function scrollToMessage(msgId) {
  const el = document.querySelector(`.msg[data-msg-id="${msgId}"]`);
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('search-highlight');
    setTimeout(() => el.classList.remove('search-highlight'), 2000);
  }
  closeSearch();
}

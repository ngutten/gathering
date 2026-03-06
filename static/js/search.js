// search.js — Hybrid search: server-side for unencrypted, client-side for encrypted
// Supports filters: from:user, on:date, to:user (mentions)

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

// Month name lookup (case-insensitive)
const MONTHS = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
  jan: 0, feb: 1, mar: 2, apr: 3, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/**
 * Parse a date string into { start: ISO, end: ISO } range.
 * Supported formats:
 *   - M/D/Y or M/D (slash-separated)
 *   - "Month Day" or "Month Day Year"
 *   - Just a month name (full range)
 *   - Just a year (4 digits)
 */
function parseDateFilter(str) {
  str = str.trim();

  // M/D/Y or M/D
  const slashMatch = str.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
  if (slashMatch) {
    const m = parseInt(slashMatch[1], 10) - 1;
    const d = parseInt(slashMatch[2], 10);
    let y = slashMatch[3] ? parseInt(slashMatch[3], 10) : new Date().getFullYear();
    if (y < 100) y += 2000;
    const start = new Date(y, m, d);
    const end = new Date(y, m, d + 1);
    return { start: start.toISOString(), end: end.toISOString() };
  }

  // Just a 4-digit year
  const yearMatch = str.match(/^(\d{4})$/);
  if (yearMatch) {
    const y = parseInt(yearMatch[1], 10);
    return { start: new Date(y, 0, 1).toISOString(), end: new Date(y + 1, 0, 1).toISOString() };
  }

  // Month [Day] [Year] — e.g. "March", "March 5", "March 5 2025"
  const parts = str.split(/\s+/);
  const monthNum = MONTHS[parts[0].toLowerCase()];
  if (monthNum !== undefined) {
    const currentYear = new Date().getFullYear();
    if (parts.length === 1) {
      // Just month — use current year
      return { start: new Date(currentYear, monthNum, 1).toISOString(), end: new Date(currentYear, monthNum + 1, 1).toISOString() };
    }
    const day = parseInt(parts[1], 10);
    let year = parts[2] ? parseInt(parts[2], 10) : currentYear;
    if (year < 100) year += 2000;
    if (isNaN(day)) {
      return { start: new Date(currentYear, monthNum, 1).toISOString(), end: new Date(currentYear, monthNum + 1, 1).toISOString() };
    }
    const start = new Date(year, monthNum, day);
    const end = new Date(year, monthNum, day + 1);
    return { start: start.toISOString(), end: end.toISOString() };
  }

  return null;
}

/**
 * Parse search input into { query, from, dateRange, mentions }.
 * Filters are extracted and the remaining text is the query.
 */
function parseSearchInput(input) {
  let from = null;
  let dateRange = null;
  let mentions = null;

  // Extract from:value
  input = input.replace(/\bfrom:(\S+)/gi, (_, val) => { from = val; return ''; });
  // Extract to:value (mentions)
  input = input.replace(/\bto:(\S+)/gi, (_, val) => { mentions = val; return ''; });
  // Extract on:value — may contain spaces for "Month Day Year", so grab until next filter or end
  input = input.replace(/\bon:("[^"]+"|[^\s]+(?:\s+\d{1,2}(?:\s+\d{2,4})?)?)/gi, (match, val) => {
    val = val.replace(/^"|"$/g, ''); // strip quotes
    dateRange = parseDateFilter(val);
    return '';
  });

  const query = input.replace(/\s+/g, ' ').trim();
  return { query, from, dateRange, mentions };
}

export function executeSearch() {
  const raw = document.getElementById('search-input').value.trim();
  if (!raw) return;

  const { query, from, dateRange, mentions } = parseSearchInput(raw);

  const ch = state.currentChannel;
  const isEncrypted = state.encryptedChannels.has(ch) && state.channelKeys[ch];

  if (isEncrypted) {
    clientSideSearch(raw, ch, query, from, dateRange, mentions);
  } else {
    const msg = { query, channel: ch };
    if (from) msg.from = from;
    if (mentions) msg.mentions = mentions;
    if (dateRange) {
      msg.date_start = dateRange.start;
      msg.date_end = dateRange.end;
    }
    send('SearchMessages', msg);
  }
}

function clientSideSearch(raw, channel, query, from, dateRange, mentions) {
  send('History', { channel, limit: 1000 });
  state._pendingSearch = { raw, channel, query, from, dateRange, mentions };
}

export function handleSearchHistory(msg) {
  if (!state._pendingSearch) return false;
  if (msg.channel !== state._pendingSearch.channel) return false;

  const { query, from, dateRange, mentions } = state._pendingSearch;
  const displayQuery = state._pendingSearch.raw;
  const channel = state._pendingSearch.channel;
  state._pendingSearch = null;

  const key = state.channelKeys[channel];
  const results = [];
  const lowerQuery = query.toLowerCase();

  for (const m of msg.messages) {
    let content = m.content;
    if (m.encrypted && key) {
      const dec = decryptMessage(m.content, key);
      if (dec !== null) content = dec;
      else continue;
    }

    // Apply filters
    if (lowerQuery && !content.toLowerCase().includes(lowerQuery)) continue;
    if (from && m.author.toLowerCase() !== from.toLowerCase()) continue;
    if (mentions && (!m.mentions || !m.mentions.some(u => u.toLowerCase() === mentions.toLowerCase()))) continue;
    if (dateRange) {
      const ts = new Date(m.timestamp);
      if (ts < new Date(dateRange.start) || ts >= new Date(dateRange.end)) continue;
    }

    results.push({
      id: m.id,
      channel: channel,
      author: m.author,
      content: content,
      timestamp: m.timestamp,
    });
  }

  renderSearchResults(results, query || displayQuery);
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
  if (!query) return escaped.length > 200 ? escaped.substring(0, 200) + '...' : escaped;
  const re = new RegExp('(' + escapeRegex(escapeHtml(query)) + ')', 'gi');
  let result = escaped.replace(re, '<mark>$1</mark>');
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

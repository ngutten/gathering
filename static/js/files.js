// files.js — File manager overlay panel

import state from './state.js';
import { send } from './transport.js';
import { escapeHtml, formatFileSize } from './render.js';

let fileManagerOpen = false;
let currentFiles = [];
let usedBytes = 0;
let quotaBytes = 0;

export function openFileManager() {
  fileManagerOpen = true;
  send('ListMyFiles');
  const overlay = document.getElementById('files-overlay');
  overlay.classList.add('active');
}

export function closeFileManager() {
  fileManagerOpen = false;
  document.getElementById('files-overlay').classList.remove('active');
}

export function handleMyFileList(msg) {
  currentFiles = msg.files;
  usedBytes = msg.used_bytes;
  quotaBytes = msg.quota_bytes;
  if (fileManagerOpen) renderFileManager();
}

export function handleFilePinned(msg) {
  const f = currentFiles.find(f => f.id === msg.file_id);
  if (f) f.pinned = msg.pinned;
  if (fileManagerOpen) renderFileManager();
}

export function handleFileDeleted(msg) {
  currentFiles = currentFiles.filter(f => f.id !== msg.file_id);
  // Recalculate used bytes
  usedBytes = currentFiles.reduce((sum, f) => sum + f.size, 0);
  if (fileManagerOpen) renderFileManager();
}

function renderFileManager() {
  const content = document.getElementById('files-content');
  if (!content) return;

  // Quota bar
  let quotaHtml = '';
  if (quotaBytes > 0) {
    const pct = Math.min(100, (usedBytes / quotaBytes) * 100);
    const color = pct > 90 ? 'var(--red)' : pct > 70 ? 'var(--orange)' : 'var(--green)';
    quotaHtml = `
      <div class="quota-info">
        <div class="quota-label">${formatFileSize(usedBytes)} / ${formatFileSize(quotaBytes)} used</div>
        <div class="quota-bar"><div class="quota-fill" style="width:${pct}%;background:${color};"></div></div>
      </div>`;
  } else {
    quotaHtml = `<div class="quota-info"><div class="quota-label">${formatFileSize(usedBytes)} used (no quota)</div></div>`;
  }

  // File list
  let filesHtml = '';
  if (currentFiles.length === 0) {
    filesHtml = '<div style="color:var(--text2);font-size:0.85rem;padding:1rem;text-align:center;">No files uploaded yet.</div>';
  } else {
    filesHtml = currentFiles.map(f => {
      const pinnedClass = f.pinned ? 'pinned' : '';
      const pinnedLabel = f.pinned ? 'Unpin' : 'Pin';
      const pinnedIcon = f.pinned ? '&#x1F4CC;' : '';
      const date = new Date(f.created_at).toLocaleDateString();
      return `<div class="file-item ${pinnedClass}">
        <div class="file-info">
          <div class="file-name-row">${pinnedIcon} ${escapeHtml(f.filename)}</div>
          <div class="file-details">${formatFileSize(f.size)} &middot; #${escapeHtml(f.channel)} &middot; ${date}</div>
        </div>
        <div class="file-actions">
          <button onclick="toggleFilePin('${f.id}', ${!f.pinned})">${pinnedLabel}</button>
          <button class="del-btn" onclick="deleteUserFile('${f.id}')">Delete</button>
        </div>
      </div>`;
    }).join('');
  }

  content.innerHTML = quotaHtml + '<div class="file-list">' + filesHtml + '</div>';
}

export function toggleFilePin(fileId, pinned) {
  send('SetFilePinned', { file_id: fileId, pinned });
}

export function deleteUserFile(fileId) {
  if (!confirm('Delete this file permanently?')) return;
  send('DeleteFile', { file_id: fileId });
}

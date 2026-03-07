// files.js — File manager overlay panel

import state from './state.js';
import { send, apiFetch } from './transport.js';
import { escapeHtml, formatFileSize } from './render.js';

let _filesPrevFocus = null;

export function openFileManager() {
  _filesPrevFocus = document.activeElement;
  state.fileManagerOpen = true;
  send('ListMyFiles');
  const overlay = document.getElementById('files-overlay');
  overlay.classList.add('active');
  requestAnimationFrame(() => {
    const focusable = overlay.querySelector('button, input, select, textarea');
    if (focusable) focusable.focus();
  });
}

export function closeFileManager() {
  state.fileManagerOpen = false;
  document.getElementById('files-overlay').classList.remove('active');
  if (_filesPrevFocus && _filesPrevFocus.focus) {
    _filesPrevFocus.focus();
    _filesPrevFocus = null;
  }
}

export function handleMyFileList(msg) {
  state.currentFiles = msg.files;
  state.usedBytes = msg.used_bytes;
  state.quotaBytes = msg.quota_bytes;
  if (state.fileManagerOpen) renderFileManager();
}

export function handleFilePinned(msg) {
  const f = state.currentFiles.find(f => f.id === msg.file_id);
  if (f) f.pinned = msg.pinned;
  if (state.fileManagerOpen) renderFileManager();
}

export function handleFileDeleted(msg) {
  state.currentFiles = state.currentFiles.filter(f => f.id !== msg.file_id);
  // Recalculate used bytes
  state.usedBytes = state.currentFiles.reduce((sum, f) => sum + f.size, 0);
  if (state.fileManagerOpen) renderFileManager();
}

function renderFileManager() {
  const content = document.getElementById('files-content');
  if (!content) return;

  // Quota bar
  let quotaHtml = '';
  if (state.quotaBytes > 0) {
    const pct = Math.min(100, (state.usedBytes / state.quotaBytes) * 100);
    const color = pct > 90 ? 'var(--red)' : pct > 70 ? 'var(--orange)' : 'var(--green)';
    quotaHtml = `
      <div class="quota-info">
        <div class="quota-label">${formatFileSize(state.usedBytes)} / ${formatFileSize(state.quotaBytes)} used</div>
        <div class="quota-bar"><div class="quota-fill" style="width:${pct}%;background:${color};"></div></div>
      </div>`;
  } else {
    quotaHtml = `<div class="quota-info"><div class="quota-label">${formatFileSize(state.usedBytes)} used (no quota)</div></div>`;
  }

  // File list
  let filesHtml = '';
  if (state.currentFiles.length === 0) {
    filesHtml = '<div style="color:var(--text2);font-size:0.85rem;padding:1rem;text-align:center;">No files uploaded yet.</div>';
  } else {
    filesHtml = state.currentFiles.map(f => {
      const pinnedClass = f.pinned ? 'pinned' : '';
      const pinnedLabel = f.pinned ? 'Unpin' : 'Pin';
      const pinnedIcon = f.pinned ? '&#x1F4CC;' : '';
      const encIcon = f.encrypted ? ' &#x1F512;' : '';
      const date = new Date(f.created_at).toLocaleDateString();
      const downloadBtn = `<button onclick="downloadFile('${f.id}')">Download</button>`;
      return `<div class="file-item ${pinnedClass}">
        <div class="file-info">
          <div class="file-name-row">${pinnedIcon}${encIcon} ${escapeHtml(f.filename)}</div>
          <div class="file-details">${formatFileSize(f.size)} &middot; #${escapeHtml(f.channel)} &middot; ${date}</div>
        </div>
        <div class="file-actions">
          ${downloadBtn}
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

export async function downloadFile(fileId) {
  const f = state.currentFiles.find(x => x.id === fileId);
  if (!f) return;

  try {
    const res = await apiFetch(`/api/files/${fileId}`);
    const buf = await res.arrayBuffer();

    let blob;
    if (f.encrypted) {
      const channelKey = state.channelKeys[f.channel];
      if (!channelKey) {
        alert('Cannot decrypt: channel key unavailable for #' + f.channel);
        return;
      }
      const { decryptFile } = await import('./crypto.js');
      const decrypted = decryptFile(new Uint8Array(buf), channelKey);
      if (!decrypted) {
        alert('Decryption failed');
        return;
      }
      blob = new Blob([decrypted], { type: f.mime_type });
    } else {
      blob = new Blob([buf], { type: f.mime_type });
    }

    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = f.filename;
    a.click();
    URL.revokeObjectURL(a.href);
  } catch (e) {
    alert('Download failed: ' + e.message);
  }
}

export function deleteUserFile(fileId) {
  if (!confirm('Delete this file permanently?')) return;
  send('DeleteFile', { file_id: fileId });
}

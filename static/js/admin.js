// admin.js — Admin panel: settings, invites, roles

import state from './state.js';
import { send } from './transport.js';
import { escapeHtml } from './render.js';
import { emit } from './state.js';

export function openAdminPanel() {
  document.getElementById('admin-overlay').classList.add('active');
  switchAdminTab('settings');
  send('GetSettings');
}

export function closeAdminPanel() {
  document.getElementById('admin-overlay').classList.remove('active');
}

export function switchAdminTab(tab, btn) {
  document.querySelectorAll('.admin-tabs button').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  else document.querySelector(`.admin-tabs button:nth-child(${tab === 'settings' ? 1 : tab === 'invites' ? 2 : 3})`).classList.add('active');

  const content = document.getElementById('admin-tab-content');
  if (tab === 'settings') {
    send('GetSettings');
    content.innerHTML = '<div style="color:var(--text2);font-size:0.8rem;">Loading settings...</div>';
  } else if (tab === 'invites') {
    send('ListInvites');
    content.innerHTML = '<div style="color:var(--text2);font-size:0.8rem;">Loading invites...</div>';
  } else if (tab === 'roles') {
    send('ListRoles');
    content.innerHTML = '<div style="color:var(--text2);font-size:0.8rem;">Loading roles...</div>';
  }
}

export function renderAdminSettings(settings) {
  state.adminSettings = settings;
  const content = document.getElementById('admin-tab-content');
  content.innerHTML = `
    <div class="admin-field">
      <label>Registration Mode</label>
      <select onchange="updateSetting('registration_mode', this.value)">
        <option value="open" ${settings.registration_mode === 'open' ? 'selected' : ''}>Open</option>
        <option value="closed" ${settings.registration_mode === 'closed' ? 'selected' : ''}>Closed</option>
        <option value="invite" ${settings.registration_mode === 'invite' ? 'selected' : ''}>Invite Only</option>
      </select>
    </div>
    <div class="admin-field">
      <label>Channel Creation</label>
      <select onchange="updateSetting('channel_creation', this.value)">
        <option value="all" ${settings.channel_creation === 'all' ? 'selected' : ''}>All Users</option>
        <option value="admin" ${settings.channel_creation === 'admin' ? 'selected' : ''}>Admin Only</option>
      </select>
    </div>
    <div class="admin-field" style="border-top:1px solid var(--border);padding-top:1rem;margin-top:1rem;">
      <label>Delete Channel</label>
      <div style="display:flex;gap:0.3rem;">
        <input type="text" id="delete-channel-input" placeholder="channel name">
        <button class="admin-btn-sm danger" onclick="deleteChannel()">Delete</button>
      </div>
    </div>
  `;
}

export function updateSetting(key, value) {
  send('UpdateSetting', { key, value });
}

export function deleteChannel() {
  const name = document.getElementById('delete-channel-input').value.trim();
  if (!name) return;
  if (!confirm(`Delete channel #${name}? This will delete all messages, topics, and files in the channel.`)) return;
  send('DeleteChannel', { channel: name });
  document.getElementById('delete-channel-input').value = '';
}

export function createInvite() {
  send('CreateInvite');
}

export function onInviteCreated(code) {
  state.lastCreatedInvite = code;
  send('ListInvites');
}

export function renderAdminInvites(invites) {
  state.adminInvites = invites;
  const content = document.getElementById('admin-tab-content');
  let html = `<button class="admin-btn-sm" onclick="createInvite()">Generate Invite Code</button>`;

  if (state.lastCreatedInvite) {
    const safeCode = escapeHtml(state.lastCreatedInvite);
    html += `<div class="invite-code-display" style="margin-top:0.5rem;">
      <code>${safeCode}</code>
      <button data-invite-code="${safeCode}" onclick="navigator.clipboard.writeText(this.dataset.inviteCode);this.textContent='Copied!'">Copy</button>
    </div>`;
  }

  html += '<div style="margin-top:1rem;">';
  if (invites.length === 0) {
    html += '<div style="color:var(--text2);font-size:0.8rem;">No invite codes yet.</div>';
  } else {
    for (const inv of invites) {
      const status = inv.used_by ? `used by ${inv.used_by}` : 'unused';
      const statusClass = inv.used_by ? 'used' : 'unused';
      html += `<div class="invite-list-item">
        <code>${escapeHtml(inv.code)}</code>
        <span class="invite-status ${statusClass}">${status}</span>
      </div>`;
    }
  }
  html += '</div>';
  content.innerHTML = html;
}

export function renderAdminRoles(roles) {
  state.adminRoles = roles;
  const content = document.getElementById('admin-tab-content');
  let html = '';

  for (const role of roles) {
    const quotaLabel = role.disk_quota_mb ? `${role.disk_quota_mb} MB` : 'unlimited';
    html += `<div class="role-item">
      <div class="role-item-header">
        <span class="role-item-name">${escapeHtml(role.name)}</span>
        <span class="role-item-perms">Quota: ${quotaLabel}</span>
      </div>
      <div class="role-item-perms">${role.permissions.map(p => escapeHtml(p)).join(', ') || 'none'}</div>
    </div>`;
  }

  html += `<div style="border-top:1px solid var(--border);padding-top:1rem;margin-top:1rem;">
    <label style="font-size:0.75rem;color:var(--text2);display:block;margin-bottom:0.3rem;">Assign Role to User</label>
    <div class="admin-user-role">
      <input type="text" id="role-assign-user" placeholder="username">
      <select id="role-assign-role">
        ${roles.map(r => `<option value="${escapeHtml(r.name)}">${escapeHtml(r.name)}</option>`).join('')}
      </select>
      <button class="admin-btn-sm" onclick="assignRoleToUser()">Assign</button>
      <button class="admin-btn-sm danger" onclick="removeRoleFromUser()">Remove</button>
    </div>
  </div>`;

  content.innerHTML = html;
}

export function assignRoleToUser() {
  const username = document.getElementById('role-assign-user').value.trim();
  const role = document.getElementById('role-assign-role').value;
  if (!username || !role) return;
  send('AssignRole', { username, role_name: role });
}

export function removeRoleFromUser() {
  const username = document.getElementById('role-assign-user').value.trim();
  const role = document.getElementById('role-assign-role').value;
  if (!username || !role) return;
  send('RemoveRole', { username, role_name: role });
}

export function onUserRolesResponse(username, roles) {
  emit('system-message', `Roles for ${username}: ${roles.join(', ') || 'none'}`);
}

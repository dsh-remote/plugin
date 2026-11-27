'use strict';

const badges = {
  running: '进行中', detached: '等待主机', 'awaiting-permission': '待审批', 'awaiting-answer': '待回答',
};

function displayTime(value, now = new Date()) {
  const date = new Date(value);
  if (!value || !Number.isFinite(date.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  if (date.toDateString() === now.toDateString()) return pad(date.getHours()) + ':' + pad(date.getMinutes());
  const monthDay = pad(date.getMonth() + 1) + '-' + pad(date.getDate());
  return date.getFullYear() === now.getFullYear() ? monthDay : date.getFullYear() + '-' + monthDay;
}

function projectName(path) {
  return path.split(/[\\/]+/).filter(Boolean).pop() || '未分组';
}

function selectSessions(sessions, pins = []) {
  const sorted = sessions.filter((row) => row.origin !== 'subagent')
    .sort((a, b) => (Date.parse(b.updatedAt || b.createdAt) || 0) - (Date.parse(a.updatedAt || a.createdAt) || 0));
  const pending = [];
  const pinned = { key: 'pinned', path: null, title: '已置顶', items: [] };
  const groups = new Map();
  const projects = new Map();
  let archivedCount = 0;
  for (const row of sorted) {
    if (row.state === 'archived') {
      archivedCount += 1;
      continue;
    }
    const path = row.workspace || '';
    const title = projectName(path);
    if (path && !projects.has(path)) projects.set(path, { path, title });
    const item = {
      ...row, title: row.title || '新会话', time: displayTime(row.updatedAt || row.createdAt),
      badge: badges[row.state] || '', pinned: pins.includes(row.id),
    };
    if (row.state === 'awaiting-permission' || row.state === 'awaiting-answer') pending.push(item);
    if (item.pinned) pinned.items.push(item);
    else {
      if (!groups.has(path)) groups.set(path, { path, key: 'project:' + path, title, items: [] });
      groups.get(path).items.push(item);
    }
  }
  return { groups: [...(pinned.items.length ? [pinned] : []), ...groups.values()],
    pending, projects: [...projects.values()], archivedCount };
}

module.exports = { selectSessions };

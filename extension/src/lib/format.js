// 展示与导出用的格式化函数（纯逻辑，可单元测试）。

export function formatClock(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function formatDateTime(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function formatBytes(n) {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`;
}

// 导出文件里的说话人（英文，不随界面语言变）；界面上用 ui/common.js 的 speakerName。
export function speakerLabel(seg) {
  if (seg.source === 'me') return 'Me';
  return seg.speaker ? `Speaker ${seg.speaker}` : 'Others';
}

// 去掉会议页面标题里的产品后缀，例如 "Meet - abc-defg-hij" / "xxx | Microsoft Teams"。
export function cleanTitle(title) {
  return (title || '会议')
    .replace(/\s*[|\-–]\s*Microsoft Teams\s*$/i, '')
    .replace(/^Meet\s*[-–]\s*/i, 'Meet ')
    .trim() || '会议';
}

export function safeFileName(name) {
  return (name || 'meeting').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80);
}

export function meetingFolderName(meeting) {
  return safeFileName(`${formatDateTime(meeting.startedAt).replace(':', '')} ${meeting.title || ''}`);
}

export function buildMarkdown(meeting, segments) {
  const lines = [];
  lines.push(`# ${meeting.title || 'Meeting'}`);
  lines.push('');
  lines.push(`- Time: ${formatDateTime(meeting.startedAt)}${meeting.endedAt ? ` – ${formatDateTime(meeting.endedAt)}` : ''}`);
  if (meeting.endedAt) lines.push(`- Duration: ${formatClock(meeting.endedAt - meeting.startedAt)}`);
  if (meeting.url) lines.push(`- Link: ${meeting.url}`);
  const gaps = meeting.gaps || [];
  if (gaps.length) {
    lines.push(`- Transcript gaps: ${gaps.map((g) => `${g.source === 'me' ? 'Me' : 'Others'} ${formatClock(g.startMs)}–${formatClock(g.endMs)}`).join(', ')}`);
  }
  lines.push('');
  lines.push('## Transcript');
  lines.push('');
  for (const s of segments) {
    lines.push(`**[${formatClock(s.startMs)}] ${speakerLabel(s)}**: ${s.text}`);
    if (s.translation) lines.push(`> ${s.translation}`);
    lines.push('');
  }
  return lines.join('\n');
}

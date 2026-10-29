// 导出到 下载/meetscribe/<日期 标题>/（只能在扩展页面里调用：需要 chrome.downloads + Blob URL）。

import { getMeeting, getSegments, getChunks, listMeetings, updateMeeting } from './db.js';
import { buildMarkdown, meetingFolderName } from './format.js';
import { buildLogExport } from './log.js';

const ROOT = 'meetscribe';

// 同一场会议重复导出时覆盖旧文件（内容相同），不再生成 "them (1).webm"
export async function downloadBlob(blob, filename, conflictAction = 'overwrite') {
  const url = URL.createObjectURL(blob);
  try {
    const id = await chrome.downloads.download({ url, filename, conflictAction, saveAs: false });
    await waitDownload(id);
    return id;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}

function waitDownload(id) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { chrome.downloads.onChanged.removeListener(onChange); resolve(); }, 120_000);
    function onChange(delta) {
      if (delta.id !== id || !delta.state) return;
      if (delta.state.current === 'complete' || delta.state.current === 'interrupted') {
        clearTimeout(timer);
        chrome.downloads.onChanged.removeListener(onChange);
        delta.state.current === 'complete' ? resolve() : reject(new Error(`download interrupted: ${delta.error?.current || ''}`));
      }
    }
    chrome.downloads.onChanged.addListener(onChange);
  });
}

export async function buildTrackBlob(meetingId, source) {
  const chunks = await getChunks(meetingId, source);
  if (!chunks.length) return null;
  const type = chunks[0].blob.type || 'audio/webm';
  return new Blob(chunks.map((c) => c.blob), { type });
}

export async function exportMeeting(meetingId, { audio = true, markdown = true, log } = {}) {
  const meeting = await getMeeting(meetingId);
  if (!meeting) throw new Error('meeting not found');
  const folder = `${ROOT}/${meetingFolderName(meeting)}`;
  const files = [];
  if (markdown) {
    const segs = await getSegments(meetingId);
    const md = buildMarkdown(meeting, segs);
    await downloadBlob(new Blob([md], { type: 'text/markdown;charset=utf-8' }), `${folder}/transcript.md`);
    files.push('transcript.md');
  }
  if (audio) {
    for (const source of ['them', 'me']) {
      const blob = await buildTrackBlob(meetingId, source);
      if (!blob) continue;
      // 文件名用来源 id：them.webm（对方）/ me.webm（我）
      await downloadBlob(blob, `${folder}/${source}.webm`);
      files.push(`${source}.webm`);
    }
  }
  log?.info('meeting exported', { meetingId, folder, files });
  return { folder, files };
}

// 会议结束时若开启了"自动导出"，SW 会标记 exportPending，由打开的扩展页面执行。
let pendingRunning = false;
export async function runPendingExports(log) {
  if (pendingRunning) return;
  pendingRunning = true;
  try {
    const meetings = await listMeetings();
    for (const m of meetings) {
      if (!m.exportPending || m.status === 'recording') continue;
      try {
        await updateMeeting(m.id, (x) => { x.exportPending = false; });
        await exportMeeting(m.id, { log });
      } catch (e) {
        log?.error('auto export failed', { meetingId: m.id, error: e });
      }
    }
  } finally {
    pendingRunning = false;
  }
}

export async function exportLogs({ fromTs, toTs, meta, filter, label = 'all' } = {}) {
  const text = await buildLogExport({ fromTs, toTs, meta, filter });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  await downloadBlob(new Blob([text], { type: 'application/x-ndjson' }), `${ROOT}/logs/meetscribe-${label}-${stamp}.jsonl`);
}

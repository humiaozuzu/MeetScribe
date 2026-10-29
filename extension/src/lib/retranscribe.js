// 会后补转：把本地录音交给 Soniox 异步接口，结果合并回字幕时间轴。
//   mode 'gaps'：只取落在转写缺口里的部分，追加为补转片段（标"补转"）。
//   mode 'full'：用整场异步结果替换这一路的全部字幕（通常比实时更准）。
// 任务状态写在 meeting.jobs，页面关闭后重新打开可以继续轮询。

import { getMeeting, getSegments, updateMeeting, replaceSegments, addSegments } from './db.js';
import { buildTrackBlob } from './exporter.js';
import { transcribeBlob, buildAsyncConfig, meetingLanguageHints } from './soniox-async.js';
import { meetingTopic } from './soniox-realtime.js';
import { tokensToSegments } from './transcript.js';
import { inheritSpeakerNames, pruneSpeakers } from './speakers.js';


export function openGaps(meeting, source) {
  return (meeting.gaps || []).filter((g) => (!source || g.source === source) && !g.filled);
}

async function saveJob(meetingId, source, patch) {
  return updateMeeting(meetingId, (m) => {
    const jobs = m.jobs || [];
    const idx = jobs.findIndex((j) => j.source === source);
    const next = { ...(idx >= 0 ? jobs[idx] : { source }), ...patch, updatedAt: Date.now() };
    if (idx >= 0) jobs[idx] = next; else jobs.push(next);
    m.jobs = jobs;
  });
}

export async function runRetranscribe({ meetingId, source, mode, settings, log, onProgress, signal }) {
  const jlog = log.child({ meetingId, source, mode });
  const meeting = await getMeeting(meetingId);
  if (!meeting) throw new Error('meeting not found');
  if (!settings.sonioxApiKey) throw new Error('no Soniox API key');
  const track = meeting.tracks?.[source];
  const blob = await buildTrackBlob(meetingId, source);
  if (!blob) throw new Error(`no recording for source "${source}"`);

  const gaps = mode === 'gaps' ? openGaps(meeting, source) : null;
  if (mode === 'gaps' && !gaps.length) return { segments: 0, skipped: true };

  const prev = (meeting.jobs || []).find((j) => j.source === source && j.status === 'running' && j.mode === mode);
  const resume = prev ? { fileId: prev.fileId, transcriptionId: prev.transcriptionId } : {};
  const config = buildAsyncConfig(settings, {
    diarization: source === 'them' && settings.enableDiarization,
    languageHints: meetingLanguageHints(meeting, settings.languageHints),
    topic: meetingTopic(meeting.title),
  });
  jlog.info('retranscribe start', { blobSize: blob.size, gaps, resume, config });
  await saveJob(meetingId, source, { mode, status: 'running', startedAt: prev?.startedAt || Date.now(), error: null, ...resume });

  try {
    const tokens = await transcribeBlob({
      key: settings.sonioxApiKey,
      blob,
      filename: `${meetingId}-${source}.webm`,
      config,
      log: jlog,
      onProgress,
      signal,
      resume,
      onIds: (ids) => saveJob(meetingId, source, ids).catch((e) => jlog.warn('save job ids failed', e)),
    });

    // 录音文件的 0 秒 = MediaRecorder 开始时刻
    const offsetMs = track?.startOffsetMs ?? 0;
    // 每次异步结果一套说话人编号，键里带上这次的标签，免得和之前的结果混在一起
    const tag = `${mode === 'full' ? 'a' : 'g'}${Date.now().toString(36)}`;
    const segs = tokensToSegments(tokens, { source, offsetMs, origin: 'async', gaps, tag })
      .map((s) => ({ ...s, meetingId }));

    let oldSegs = null;
    if (mode === 'full') {
      oldSegs = (await getSegments(meetingId)).filter((s) => s.source === source);
      await replaceSegments(meetingId, source, segs);
    } else {
      // 只补本次未填的缺口；已填过的缺口不在 gaps 里，不会重复
      await addSegments(segs);
    }
    const remaining = mode === 'full' ? await getSegments(meetingId) : null;
    await updateMeeting(meetingId, (m) => {
      m.gaps = (m.gaps || []).map((g) => (g.source === source ? { ...g, filled: true } : g));
      if (mode === 'full') {
        m.retranscribed = { ...(m.retranscribed || {}), [source]: Date.now() };
        // 按时间重叠把旧结果里改过的名字带到新说话人上，再清掉不再用到的旧条目
        const inherit = inheritSpeakerNames({ speakers: m.speakers, oldSegments: oldSegs, newSegments: segs });
        m.speakers = pruneSpeakers({ ...(m.speakers || {}), ...inherit.entries }, remaining);
        jlog.info('speaker names inherited', { newSpeakers: inherit.newSpeakers, matches: inherit.matches });
      }
    });
    await saveJob(meetingId, source, { status: 'done', segments: segs.length, tokens: tokens.length, fileId: null, transcriptionId: null });
    jlog.info('retranscribe done', { tokens: tokens.length, segments: segs.length });
    return { segments: segs.length };
  } catch (e) {
    await saveJob(meetingId, source, { status: 'error', error: String(e.message || e) }).catch(() => {});
    throw e;
  }
}

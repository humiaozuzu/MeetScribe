// 会议中的 AI 纪要：每 5 秒看一次，有新定稿的片段、到了间隔（notesDue）就调 updateNotes 做一次增量更新。
// 会议结束后 SW 发 offscreen:finish-notes，finish() 等进行中的那次做完，再对全文整理一次（final）。
// 住在 offscreen 里，所以和侧边栏开没开无关。key 无效 / 没额度 / 模型不存在时本场不再尝试。

import { EVT, broadcast } from '../lib/messages.js';
import { notesDue } from '../lib/notes.js';
import { updateNotes, notesErrorState } from '../lib/notes-runner.js';

const TICK_MS = 5000;
const HEARTBEAT_MS = 15_000;
const FATAL_STATES = new Set(['no-key', 'invalid-key', 'no-quota', 'model']);

export class LiveNotes {
  constructor({ meetingId, settings, log, notes }) {
    this.meetingId = meetingId;
    this.settings = settings;
    this.log = log.child({ part: 'notes' });
    this.lastSegId = notes?.lastSegId || 0;
    this.empty = !notes;
    this.newIds = [];
    this.lastAttempt = Date.now();
    this.state = 'idle';
    this.error = null;
    this.running = null; // 进行中的 update Promise
  }

  start() {
    if (!this.settings.liveNotes) {
      this.log.info('live notes off — notes will be written once after the meeting');
      return;
    }
    this.timer = setInterval(() => this._tick(), TICK_MS);
    this.log.info('live notes started', { model: this.settings.openaiModel, notesLanguage: this.settings.notesLanguage || '(ui)' });
  }

  stopTimer() {
    clearInterval(this.timer);
    this.timer = null;
  }

  // 新片段存进数据库后调用（id 已分配）
  onSaved(seg) {
    if (seg.id != null && seg.id > this.lastSegId) this.newIds.push(seg.id);
  }

  _setState(state, extra = {}) {
    this.state = state;
    this.error = extra.error || null;
    broadcast({ type: EVT.NOTES, meetingId: this.meetingId, state, ...extra });
  }

  _tick() {
    if (this.running || FATAL_STATES.has(this.state)) return;
    if (!notesDue({ notes: this.empty ? null : { summary: 'x' }, newLines: this.newIds.length, sinceLastMs: Date.now() - this.lastAttempt })) return;
    this._run(false);
  }

  updateNow() {
    if (this.running) return { ok: true, busy: true };
    if (FATAL_STATES.has(this.state)) this.state = 'idle'; // 用户可能刚改了设置，再试一次
    this._run(false);
    return { ok: true };
  }

  _run(final) {
    this.lastAttempt = Date.now();
    this._setState(final ? 'finalizing' : 'updating');
    this.running = (async () => {
      try {
        const { notes, changed } = await updateNotes({ meetingId: this.meetingId, settings: this.settings, final, log: this.log });
        if (notes) {
          this.lastSegId = notes.lastSegId || this.lastSegId;
          this.empty = false;
        }
        this.newIds = this.newIds.filter((id) => id > this.lastSegId);
        this._setState(final ? 'done' : 'idle', changed ? { notes } : {});
      } catch (e) {
        const state = notesErrorState(e);
        this.log.error('notes update failed', { final, state, status: e.status, code: e.code, message: e.message });
        this._setState(state, { error: e.message });
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  // 会后整理完整纪要。期间每 15 秒广播一次状态：页面能看到进度，SW 收到消息也不会被挂起。
  async finish() {
    this.stopTimer();
    const heartbeat = setInterval(() => broadcast({ type: EVT.NOTES, meetingId: this.meetingId, state: 'finalizing' }), HEARTBEAT_MS);
    try {
      await this.running;
      if (this.state === 'no-key') return { ok: true, skipped: 'no-key' };
      this.log.info('final notes pass');
      await this._run(true);
      return { ok: true, state: this.state };
    } finally {
      clearInterval(heartbeat);
    }
  }
}

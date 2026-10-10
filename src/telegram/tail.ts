import fs from 'fs';
import { bot, apiRef } from '../core/runtime';
import { getPromptStatusPath } from '../core/status';
import { buildMessageWithHeaderAndFooter, buildStatusFromParts, escapeHtml, formatDuration, toMs } from './formatters';
import { localRunStatus, unwrapSessionList } from '../core/ctx';

export interface TailTracking {
  sessionId: string;
  chatId: number;
  messageId: number;
  lastText: string;
  lastEditAt: number;
  isComplete: boolean;
  timer: any;
  hasStartedRunning?: boolean;
  startedAt: number;
}

export const activeTails = new Map<number, TailTracking>();

const POLL_INTERVAL_MS = 2000;
const EDIT_THROTTLE_MS = 1200;
const MAX_MESSAGE_LEN = 4000;
const IDLE_START_GRACE_MS = 15000;
const EXPIRY_MS = 30 * 60 * 1000;

const roleOf = (m: any): string => m.type || (m.info || m).role;

/** Text of the last prompt status file written by the plugin, if any. */
function readLiveStatus(sessionId: string): string {
  const statusFile = getPromptStatusPath(sessionId);
  if (!fs.existsSync(statusFile)) return '';
  try {
    const data = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
    if (data.isComplete) return data.text || '';
    return data.status || '';
  } catch (e) {
    return '';
  }
}

function computeAssistantDuration(msgs: any[], lastAssistant: any): string {
  const assistantIndex = msgs.findIndex(m => (m.id || m.requestID) === (lastAssistant.id || lastAssistant.requestID));
  const lastUserMsg = assistantIndex > 0 ? msgs[assistantIndex - 1] : null;
  if (!lastUserMsg) return '';

  const startMs = toMs(lastUserMsg.time?.created || lastUserMsg.timeCreated);
  const endMs = toMs(lastAssistant.time?.completed || lastAssistant.time?.updated || lastAssistant.timeUpdated || lastAssistant.time?.created || lastAssistant.timeCreated);
  return startMs && endMs && endMs >= startMs ? formatDuration((endMs - startMs) / 1000) : '';
}

export async function getSessionActiveContent(
  sessionId: string,
  directory: string
): Promise<{
  activeText: string;
  lastAssistant: any;
  statusType: string;
  historyMsgs: any[];
  lastMsgIsAssistant: boolean;
  calculatedDurationStr?: string;
}> {
  const msgsRes = await apiRef.client.message.list({ sessionID: sessionId, limit: 10 }).catch(() => null);
  const msgs = unwrapSessionList(msgsRes);

  // v2 has no session.status client method — the local store tracks run state.
  const rawStatus = localRunStatus(sessionId);
  const statusType = rawStatus === 'running' ? 'busy' : rawStatus;

  let lastAssistant: any = null;
  let historyMsgs = msgs;
  let lastMsgIsAssistant = false;

  if (msgs.length > 0) {
    if (roleOf(msgs[msgs.length - 1]) === 'assistant') {
      lastAssistant = msgs[msgs.length - 1];
      historyMsgs = msgs.slice(0, -1);
      lastMsgIsAssistant = true;
    } else {
      lastAssistant = [...msgs].reverse().find(m => roleOf(m) === 'assistant') || null;
    }
  }

  const calculatedDurationStr = lastAssistant ? computeAssistantDuration(msgs, lastAssistant) : '';

  const fallbackText = statusType === 'idle' ? '✅ Done' : '⏳ Processing...';
  const activeText = readLiveStatus(sessionId)
    || (lastAssistant ? buildStatusFromParts(lastAssistant.content || lastAssistant.parts || []) : fallbackText);

  return { activeText, lastAssistant, statusType, historyMsgs, lastMsgIsAssistant, calculatedDurationStr };
}

export function notifySessionIdle(sessionId: string) {
  // No-op since prompt tracking is removed in favor of persistent tail logs
}

/** When the parent is idle, an active child/sub-session keeps the tail alive. */
async function resolveEffectiveStatus(sessionId: string, directory: string, statusType: string): Promise<string> {
  if (statusType !== 'idle') return statusType;
  try {
    const listRes = await apiRef.client.session.list({ directory, limit: 50 }).catch(() => null);
    const sessions = unwrapSessionList(listRes);
    if (!Array.isArray(sessions)) return statusType;

    const children = sessions.filter((s: any) => s.parentID === sessionId && s.status !== 'deleted' && !s.time?.archived);
    if (children.length === 0) return statusType;

    const hasActiveChild = children.some((s: any) => {
      try {
        const st = localRunStatus(s.id);
        return st !== 'idle';
      } catch (e) {
        return false;
      }
    });
    if (hasActiveChild) return 'running';
  } catch (e) { /* child check best-effort */ }
  return statusType;
}

function renderHistoryMessage(m: any): { role: string; text: string } {
  const role = roleOf(m);
  if (role === 'assistant') {
    return { role, text: buildStatusFromParts(m.content || m.parts || []) };
  }
  // v2 user messages carry `text` directly; fall back to v1 parts parsing.
  const rawText = String(m.text || (m.content ?? '') || (m.parts || [])
    .map((p: any) => {
      if (p.type === 'text') return p.text || '';
      if (p.type === 'tool_result') return p.content || '';
      return '';
    })
    .filter(Boolean)
    .join('\n')).trim();
  return { role, text: escapeHtml(rawText.length > 300 ? rawText.slice(0, 300) + '...' : rawText) };
}

const ROLE_ICONS: Record<string, string> = { user: '👤', assistant: '🤖' };

export function startTailTracking(
  sessionId: string,
  chatId: number,
  trackingMessageId: number,
  directory: string
) {
  const tracking: TailTracking = {
    sessionId,
    chatId,
    messageId: trackingMessageId,
    lastText: '',
    lastEditAt: 0,
    isComplete: false,
    timer: null as any,
    hasStartedRunning: false,
    startedAt: Date.now()
  };
  activeTails.set(trackingMessageId, tracking);

  let pendingEdit: ReturnType<typeof setTimeout> | null = null;

  // retryWithHtml: whether the fallback attempt keeps parse_mode HTML (final edits) or drops it (live edits)
  function sendEdit(text: string, retryWithHtml: boolean) {
    const edit = (parseMode?: 'HTML') => bot?.editMessageText(text, {
      chat_id: chatId,
      message_id: trackingMessageId,
      ...(parseMode ? { parse_mode: parseMode } : {}),
      reply_markup: {
        inline_keyboard: tracking.isComplete ? [] : [[{ text: '❌ Stop Tailing', callback_data: `stop_tracking_${trackingMessageId}` }]]
      }
    });
    edit('HTML')?.catch((err: any) => {
      if ((err?.message || String(err)).includes('message is not modified')) return;
      edit(retryWithHtml ? 'HTML' : undefined)?.catch(() => {});
    });
  }

  function editMessageDirectly(text: string) {
    const safeText = text.slice(0, MAX_MESSAGE_LEN);
    tracking.lastText = safeText;
    if (pendingEdit) { clearTimeout(pendingEdit); pendingEdit = null; }
    sendEdit(safeText, true);
  }

  function scheduleEdit(text: string) {
    if (tracking.isComplete) return;
    const safeText = text.slice(0, MAX_MESSAGE_LEN);
    if (safeText === tracking.lastText) return;
    tracking.lastText = safeText;

    if (pendingEdit) clearTimeout(pendingEdit);
    const sinceLastEdit = Date.now() - tracking.lastEditAt;
    const delay = Math.max(0, EDIT_THROTTLE_MS - sinceLastEdit);

    pendingEdit = setTimeout(() => {
      if (tracking.isComplete && tracking.lastText === safeText) return;
      tracking.lastEditAt = Date.now();
      sendEdit(safeText, false);
    }, delay);
  }

  let lastActivityTimestamp = Date.now();
  let lastFormattedContent = '';
  let promptStartedAt: number | null = null;
  let frozenDuration = '';

  const messageCache = new Map<string, { role: string, text: string }>();
  const messageOrder: string[] = [];

  tracking.timer = setInterval(async () => {
    try {
      if (tracking.isComplete) return;
      const { activeText, lastAssistant, statusType, historyMsgs, lastMsgIsAssistant, calculatedDurationStr } = await getSessionActiveContent(sessionId, directory);
      const effectiveStatusType = await resolveEffectiveStatus(sessionId, directory, statusType);

      // Add new history messages to our local cache
      historyMsgs.forEach((m: any) => {
        const msgId = m.id || m.requestID || String(m.time?.updated || m.timeUpdated || Math.random());
        if (messageCache.has(msgId)) return;
        const rendered = renderHistoryMessage(m);
        if (rendered.text) {
          messageCache.set(msgId, rendered);
          messageOrder.push(msgId);
        }
      });

      // Keep only the last 1 message in history (the last user prompt)
      while (messageOrder.length > 1) {
        messageCache.delete(messageOrder.shift()!);
      }

      const formattedHistory = messageOrder
        .map(id => messageCache.get(id))
        .filter(Boolean)
        .map(c => `${ROLE_ICONS[c!.role] || '❓'} ${c!.text}\n\n`)
        .join('');

      const formattedActive = (effectiveStatusType !== 'idle' || lastMsgIsAssistant) ? `🤖 ${activeText}\n\n` : '';
      const contentText = `${formattedHistory}${formattedActive}`.trim();

      if (contentText !== lastFormattedContent || effectiveStatusType !== 'idle') {
        lastActivityTimestamp = Date.now();
        lastFormattedContent = contentText;
      }

      // Manage duration tracking and track if prompt has started running
      if (effectiveStatusType !== 'idle') {
        tracking.hasStartedRunning = true;
        if (!promptStartedAt) promptStartedAt = Date.now();
        frozenDuration = '';
      } else if (promptStartedAt) {
        frozenDuration = formatDuration((Date.now() - promptStartedAt) / 1000);
        promptStartedAt = null;
      } else if (calculatedDurationStr) {
        frozenDuration = calculatedDurationStr;
      }

      const durationStr = promptStartedAt
        ? formatDuration((Date.now() - promptStartedAt) / 1000)
        : (frozenDuration || '0.0s');

      // Finalize tail if session goes idle (and has started running, or has been idle for 15s since tail started)
      const timeSinceStart = Date.now() - tracking.startedAt;
      const isSessionCompleted = effectiveStatusType === 'idle' && (tracking.hasStartedRunning || timeSinceStart > IDLE_START_GRACE_MS);
      const isExpired = Date.now() - lastActivityTimestamp > EXPIRY_MS;
      const isFinal = isSessionCompleted || isExpired;

      if (isFinal) {
        tracking.isComplete = true;
        clearInterval(tracking.timer);
        activeTails.delete(trackingMessageId);
      }

      const finalMsg = await buildMessageWithHeaderAndFooter(sessionId, contentText, lastAssistant, lastActivityTimestamp, durationStr);
      if (isFinal) editMessageDirectly(finalMsg);
      else scheduleEdit(finalMsg);
    } catch (err) {
      console.error('[Telegram] Tail polling interval error:', err);
    }
  }, POLL_INTERVAL_MS);
}

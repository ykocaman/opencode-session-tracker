import fs from 'fs';
import { bot, apiRef, readState, writeState, activeProjectDir, sessionFinalizers, lastHistoryMessage, lastSessionsMessage } from './state';
import { activeTails } from './bot';
import { getPromptStatusPath } from './state';
import { buildMessageWithHeaderAndFooter, buildStatusFromParts, escapeHtml, formatThinkingText } from './formatters';
import { handleTailCommand, handleSessionsCommand, handleHistoryCommand } from './commands';
import { getSessionsKeyboard } from './keyboards';


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
  const msgsRes = await apiRef.client.session.messages({ sessionID: sessionId, limit: 10 }).catch(() => null);
  const msgs = (msgsRes?.data || msgsRes || []) as any[];

  const statusRes = await apiRef.client.session.status({ directory }).catch(() => null);
  const statuses = statusRes?.data || statusRes || {};
  const sessionStatus = statuses[sessionId];
  const statusType = sessionStatus?.type || 'idle';

  let activeText = '⏳ Processing...';
  let lastAssistant: any = null;
  let historyMsgs = msgs;
  let lastMsgIsAssistant = false;

  if (msgs.length > 0) {
    const lastMsg = msgs[msgs.length - 1];
    if ((lastMsg.info || lastMsg).role === 'assistant') {
      lastAssistant = lastMsg;
      historyMsgs = msgs.slice(0, -1);
      lastMsgIsAssistant = true;
    } else {
      lastAssistant = [...msgs].reverse().find((m: any) => (m.info || m).role === 'assistant') || null;
    }
  }

  let lastUserMsg: any = null;
  if (lastAssistant) {
    const assistantIndex = msgs.findIndex(m => (m.id || m.requestID) === (lastAssistant.id || lastAssistant.requestID));
    if (assistantIndex > 0) {
      lastUserMsg = msgs[assistantIndex - 1];
    }
  }

  function getMs(ts: any): number {
    if (!ts) return 0;
    const num = Number(ts);
    if (isNaN(num)) return 0;
    if (num < 10000000000) return num * 1000;
    return num;
  }

  let calculatedDurationStr = '';
  if (lastAssistant && lastUserMsg) {
    const startMs = getMs(lastUserMsg.time?.created || lastUserMsg.timeCreated || lastUserMsg.time?.updated || lastUserMsg.timeUpdated);
    const endMs = getMs(lastAssistant.time?.updated || lastAssistant.timeUpdated || lastAssistant.time?.created || lastAssistant.timeCreated);
    if (startMs && endMs && endMs >= startMs) {
      const sec = (endMs - startMs) / 1000;
      calculatedDurationStr = sec < 60 ? `${sec.toFixed(1)}s` : `${Math.floor(sec/60)}m ${Math.round(sec%60)}s`;
    }
  }

  let liveStatus = '';
  const statusFile = getPromptStatusPath(sessionId);
  if (fs.existsSync(statusFile)) {
    try {
      const data = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
      if (data.isComplete) {
        liveStatus = data.text || '';
      } else if (data.status) {
        liveStatus = data.status;
      }
    } catch(e) {}
  }

  if (statusType === 'idle') {
    if (liveStatus) {
      activeText = liveStatus;
    } else if (lastAssistant) {
      activeText = buildStatusFromParts(lastAssistant.parts || []);
    } else {
      activeText = '✅ Done';
    }
  } else {
    if (liveStatus) {
      activeText = liveStatus;
    } else if (lastAssistant) {
      activeText = buildStatusFromParts(lastAssistant.parts || []);
    } else {
      activeText = '⏳ Processing...';
    }
  }

  return {
    activeText,
    lastAssistant,
    statusType,
    historyMsgs,
    lastMsgIsAssistant,
    calculatedDurationStr
  };
}

export function notifySessionIdle(sessionId: string) {
  // No-op since prompt tracking is removed in favor of persistent tail logs
}

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

  const EDIT_THROTTLE_MS = 1200;
  let pendingEdit: ReturnType<typeof setTimeout> | null = null;

  function editMessageDirectly(text: string) {
    const safeText = text.slice(0, 4000);
    tracking.lastText = safeText;
    if (pendingEdit) { clearTimeout(pendingEdit); pendingEdit = null; }
    bot?.editMessageText(safeText, {
      chat_id: chatId,
      message_id: trackingMessageId,
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: tracking.isComplete ? [] : [[{ text: '❌ Stop Tailing', callback_data: `stop_tracking_${trackingMessageId}` }]]
      }
    }).catch((err: any) => {
      const errMsg = err?.message || String(err);
      if (errMsg.includes("message is not modified")) return;
      bot?.editMessageText(safeText, {
        chat_id: chatId,
        message_id: trackingMessageId,
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: tracking.isComplete ? [] : [[{ text: '❌ Stop Tailing', callback_data: `stop_tracking_${trackingMessageId}` }]]
        }
      }).catch(() => {});
    });
  }

  function scheduleEdit(text: string) {
    if (tracking.isComplete) return;
    const safeText = text.slice(0, 4000);
    if (safeText === tracking.lastText) return;
    tracking.lastText = safeText;

    if (pendingEdit) clearTimeout(pendingEdit);
    const sinceLastEdit = Date.now() - tracking.lastEditAt;
    const delay = sinceLastEdit >= EDIT_THROTTLE_MS ? 0 : EDIT_THROTTLE_MS - sinceLastEdit;

    pendingEdit = setTimeout(() => {
      if (tracking.isComplete && tracking.lastText === safeText) return;
      tracking.lastEditAt = Date.now();
      bot?.editMessageText(safeText, {
        chat_id: chatId,
        message_id: trackingMessageId,
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: tracking.isComplete ? [] : [[{ text: '❌ Stop Tailing', callback_data: `stop_tracking_${trackingMessageId}` }]]
        }
      }).catch((err: any) => {
        const errMsg = err?.message || String(err);
        if (errMsg.includes("message is not modified")) return;
        bot?.editMessageText(safeText, {
          chat_id: chatId,
          message_id: trackingMessageId,
          reply_markup: {
            inline_keyboard: tracking.isComplete ? [] : [[{ text: '❌ Stop Tailing', callback_data: `stop_tracking_${trackingMessageId}` }]]
          }
        }).catch(() => {});
      });
    }, delay);
  }

  let lastActivityTimestamp = Date.now();
  let lastFormattedContent = '';
  let promptStartedAt: number | null = null;
  let frozenDuration = '';

  const messageCache = new Map<string, { role: string, text: string }>();
  let messageOrder: string[] = [];

  tracking.timer = setInterval(async () => {
    try {
      if (tracking.isComplete) return;
      const { activeText, lastAssistant, statusType, historyMsgs, lastMsgIsAssistant, calculatedDurationStr } = await getSessionActiveContent(sessionId, directory);

      // ponytail: when parent is idle, check for active child/sub-sessions to keep tail alive
      let effectiveStatusType = statusType;
      if (statusType === 'idle') {
        try {
          const listRes = await (apiRef.client.session as any).list({ query: { directory, limit: 50 } }).catch(() => null);
          const sessions = listRes?.data || listRes || [];
          if (Array.isArray(sessions)) {
            const children = sessions.filter((s: any) => s.parentID === sessionId && s.status !== 'deleted');
            if (children.length > 0) {
              const childStatuses = (await apiRef.client.session.status({ directory }).catch(() => null))?.data || {};
              const hasActiveChild = children.some((s: any) => {
                const st = childStatuses[s.id]?.type || s.status || 'idle';
                return st !== 'idle' && st !== 'deleted' && st !== 'error';
              });
              if (hasActiveChild) effectiveStatusType = 'running';
            }
          }
        } catch(e) {/* child check best-effort */}
      }

      // Add new history messages to our local cache
      historyMsgs.forEach((m: any) => {
        const msgId = m.id || m.requestID || String(m.time?.updated || m.timeUpdated || Math.random());
        if (!messageCache.has(msgId)) {
          const role = (m.info || m).role;
          let cleanText = '';
          
          if (role === 'assistant') {
            cleanText = buildStatusFromParts(m.parts || []);
          } else {
            const rawText = (m.parts || [])
              .map((p: any) => {
                if (p.type === 'text') return p.text || '';
                if (p.type === 'tool_result') return p.content || '';
                return '';
              })
              .filter(Boolean)
              .join('\n')
              .trim();
            cleanText = escapeHtml(rawText.length > 300 ? rawText.slice(0, 300) + '...' : rawText);
          }
          
          if (cleanText) {
            messageCache.set(msgId, { role, text: cleanText });
            messageOrder.push(msgId);
          }
        }
      });

      // Keep only the last 1 message in history (the last user prompt)
      if (messageOrder.length > 1) {
        const toRemove = messageOrder.length - 1;
        for (let i = 0; i < toRemove; i++) {
          const id = messageOrder.shift();
          if (id) messageCache.delete(id);
        }
      }

      let formattedHistory = '';
      messageOrder.forEach((msgId) => {
        const cached = messageCache.get(msgId);
        if (cached) {
          const icon = cached.role === 'user' ? '👤' : (cached.role === 'assistant' ? '🤖' : '❓');
          formattedHistory += `${icon} ${cached.text}\n\n`;
        }
      });

      let formattedActive = '';
      if (effectiveStatusType !== 'idle' || lastMsgIsAssistant) {
        formattedActive = `🤖 ${activeText}\n\n`;
      }

      const contentText = `${formattedHistory}${formattedActive}`.trim();
      
      if (contentText !== lastFormattedContent || effectiveStatusType !== 'idle') {
        lastActivityTimestamp = Date.now();
        lastFormattedContent = contentText;
      }

      // Manage duration tracking and track if prompt has started running
      if (effectiveStatusType !== 'idle') {
        tracking.hasStartedRunning = true;
        if (!promptStartedAt) {
          promptStartedAt = Date.now();
        }
        frozenDuration = '';
      } else {
        if (promptStartedAt) {
          const totalSec = (Date.now() - promptStartedAt) / 1000;
          frozenDuration = totalSec < 60 ? `${totalSec.toFixed(1)}s` : `${Math.floor(totalSec/60)}m ${Math.round(totalSec%60)}s`;
          promptStartedAt = null;
        } else if (calculatedDurationStr) {
          frozenDuration = calculatedDurationStr;
        }
      }

      const durationStr = promptStartedAt 
        ? (() => {
            const sec = (Date.now() - promptStartedAt) / 1000;
            return sec < 60 ? `${sec.toFixed(1)}s` : `${Math.floor(sec/60)}m ${Math.round(sec%60)}s`;
          })()
        : (frozenDuration || '0.0s');

      // Finalize tail if session goes idle (and has started running, or has been idle for 15s since tail started)
      const timeSinceStart = Date.now() - tracking.startedAt;
      const isSessionCompleted = effectiveStatusType === 'idle' && (tracking.hasStartedRunning || timeSinceStart > 15000);
      const isExpired = Date.now() - lastActivityTimestamp > 30 * 60 * 1000;

      if (isSessionCompleted || isExpired) {
        tracking.isComplete = true;
        clearInterval(tracking.timer);
        activeTails.delete(trackingMessageId);
        
        const finalMsg = await buildMessageWithHeaderAndFooter(sessionId, contentText, lastAssistant, lastActivityTimestamp, durationStr);
        editMessageDirectly(finalMsg);
        return;
      }

      const finalMsg = await buildMessageWithHeaderAndFooter(sessionId, contentText, lastAssistant, lastActivityTimestamp, durationStr);
      scheduleEdit(finalMsg);
    } catch(err) {
      console.error('[Telegram] Tail polling interval error:', err);
    }
  }, 2000);
}

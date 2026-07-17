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
    lastMsgIsAssistant
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
    timer: null as any
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

  const messageCache = new Map<string, { role: string, text: string }>();
  let messageOrder: string[] = [];

  tracking.timer = setInterval(async () => {
    try {
      if (tracking.isComplete) return;
      const { activeText, lastAssistant, statusType, historyMsgs, lastMsgIsAssistant } = await getSessionActiveContent(sessionId, directory);

      // Add new history messages to our local cache
      historyMsgs.forEach((m: any) => {
        const msgId = m.id || m.requestID || String(m.time?.updated || m.timeUpdated || Math.random());
        if (!messageCache.has(msgId)) {
          const role = (m.info || m).role;
          let cleanText = '';
          
          if (role === 'assistant') {
            cleanText = buildStatusFromParts(m.parts || []);
          } else {
            const rawText = (m.parts || []).filter((p: any) => p.type === 'text').map((p: any) => p.text || '').join('').trim();
            cleanText = escapeHtml(rawText.length > 300 ? rawText.slice(0, 300) + '...' : rawText);
          }
          
          if (cleanText) {
            messageCache.set(msgId, { role, text: cleanText });
            messageOrder.push(msgId);
          }
        }
      });

      // Keep only the last 5 messages in history to fit Telegram's character limits nicely
      if (messageOrder.length > 5) {
        const toRemove = messageOrder.length - 5;
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
      if (statusType !== 'idle' || lastMsgIsAssistant) {
        formattedActive = `🤖 ${activeText}\n\n`;
      }

      const contentText = `${formattedHistory}${formattedActive}`.trim();
      
      if (contentText !== lastFormattedContent || statusType !== 'idle') {
        lastActivityTimestamp = Date.now();
        lastFormattedContent = contentText;
      }

      if (Date.now() - lastActivityTimestamp > 30 * 60 * 1000) {
        tracking.isComplete = true;
        clearInterval(tracking.timer);
        activeTails.delete(trackingMessageId);
        
        const finalMsg = await buildMessageWithHeaderAndFooter(sessionId, contentText, lastAssistant, lastActivityTimestamp);
        editMessageDirectly(finalMsg);
        return;
      }

      const finalMsg = await buildMessageWithHeaderAndFooter(sessionId, contentText, lastAssistant, lastActivityTimestamp);
      scheduleEdit(finalMsg);
    } catch(err) {
      console.error('[Telegram] Tail polling interval error:', err);
    }
  }, 2000);
}

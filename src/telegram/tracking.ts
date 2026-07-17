import fs from 'fs';
import { bot, apiRef, readState, writeState, activeProjectDir, sessionFinalizers, lastHistoryMessage, lastSessionsMessage } from './state';
import { activeTrackings, activeTails } from './bot';
import { getPromptStatusPath } from './state';
import { buildMessageWithHeaderAndFooter, buildStatusFromParts, escapeHtml, formatThinkingText } from './formatters';
import { handleTailCommand, handleSessionsCommand, handleHistoryCommand } from './commands';
import { getSessionsKeyboard } from './keyboards';

export interface ActiveTracking {
  chatId: number;
  messageId: number;
  lastText: string;
  lastEditAt: number;
  accumulatedText: string;
  toolHistory: string[];
  isComplete: boolean;
  abortController?: AbortController;
  timer?: any;
}

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

export function startPollingPrompt(
  sessionId: string,
  chatId: number,
  trackingMessageId: number,
  directory: string,
  promptTimestamp: number
) {
  for (const [msgId, tail] of activeTails.entries()) {
    if (tail.sessionId === sessionId && !tail.isComplete) {
      tail.isComplete = true;
      if (tail.timer) clearInterval(tail.timer);
      activeTails.delete(msgId);
      
      const finalMsg = tail.lastText;
      bot?.editMessageText(finalMsg, {
        chat_id: tail.chatId,
        message_id: msgId,
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [] }
      }).catch(() => {});
    }
  }

  const existing = activeTrackings.get(sessionId);
  if (existing) {
    existing.isComplete = true;
    if (existing.timer) clearInterval(existing.timer);
    activeTrackings.delete(sessionId);
  }

  const tracking: ActiveTracking = {
    chatId,
    messageId: trackingMessageId,
    lastText: '',
    lastEditAt: 0,
    accumulatedText: '',
    toolHistory: [],
    isComplete: false,
    timer: null
  };
  activeTrackings.set(sessionId, tracking);

  const EDIT_THROTTLE_MS = 1200;
  let pendingEdit: ReturnType<typeof setTimeout> | null = null;

  let finalizeRef: (() => void) | null = null;
  sessionFinalizers.set(sessionId, () => { if (finalizeRef) finalizeRef(); });

  function editMessageDirectly(text: string) {
    const safeText = text.slice(0, 4000);
    tracking.lastText = safeText;
    if (pendingEdit) { clearTimeout(pendingEdit); pendingEdit = null; }
    bot?.editMessageText(safeText, {
      chat_id: chatId,
      message_id: trackingMessageId,
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: tracking.isComplete ? [] : [[{ text: '❌ Stop Tracking', callback_data: `stop_tracking_${trackingMessageId}` }]]
      }
    }).catch((err: any) => {
      const errMsg = err?.message || String(err);
      if (errMsg.includes("message is not modified")) return;
      bot?.editMessageText(safeText, {
        chat_id: chatId,
        message_id: trackingMessageId,
        reply_markup: {
          inline_keyboard: tracking.isComplete ? [] : [[{ text: '❌ Stop Tracking', callback_data: `stop_tracking_${trackingMessageId}` }]]
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
          inline_keyboard: tracking.isComplete ? [] : [[{ text: '❌ Stop Tracking', callback_data: `stop_tracking_${trackingMessageId}` }]]
        }
      }).catch((err: any) => {
        const errMsg = err?.message || String(err);
        if (errMsg.includes("message is not modified")) return;
        bot?.editMessageText(safeText, {
          chat_id: chatId,
          message_id: trackingMessageId,
          reply_markup: {
            inline_keyboard: tracking.isComplete ? [] : [[{ text: '❌ Stop Tracking', callback_data: `stop_tracking_${trackingMessageId}` }]]
          }
        }).catch(() => {});
      });
    }, delay);
  }

  editMessageDirectly('⏳ Processing...');

  async function finalizeTracking() {
    if (tracking.isComplete) return;
    tracking.isComplete = true;
    if (pendingEdit) { clearTimeout(pendingEdit); pendingEdit = null; }
    if (tracking.timer) { clearInterval(tracking.timer); tracking.timer = null; }
    activeTrackings.delete(sessionId);
    sessionFinalizers.delete(sessionId);

    // Clear pendingPrompt from state
    try {
      const ns = readState();
      if (ns.pendingPrompt?.sessionId === sessionId) {
        delete ns.pendingPrompt;
        writeState(ns);
      }
    } catch(e) {}

    try {
      const msgsRes = await apiRef.client.session.messages({ sessionID: sessionId, limit: 10 });
      const msgs = (msgsRes?.data || msgsRes || []) as any[];
      const lastAssistant = [...msgs].reverse().find((m: any) => {
        const role = (m.info || m).role;
        if (role !== 'assistant') return false;
        const t = (m.parts || []).filter((p: any) => p.type === 'text').map((p: any) => p.text || '').join('').trim();
        return t.length > 0;
      });

      if (lastAssistant) {
        const allParts = lastAssistant.parts || [];
        let rendered = '';
        for (const p of allParts) {
          if (p.type === 'text') {
            const t = (p.text || '').trim();
            if (t) rendered += escapeHtml(t) + '\n\n';
          } else if (p.type === 'reasoning') {
            const t = (p.text || '').trim();
            if (t) rendered += `🧠 <i>Thinking: ${escapeHtml(formatThinkingText(t))}</i>\n\n`;
          } else if (p.type === 'tool') {
            const name = p.tool || '';
            const input = (p.state?.input?.command || p.state?.input?.CommandLine || '').trim();
            const escInput = escapeHtml(input);
            rendered += (name === 'bash' || name === 'execute_command' || name === 'run_command')
              ? `<code>$ ${escInput.slice(0, 200)}</code>\n`
              : `⚡ <code>${name}</code>\n`;
            const output = (p.state?.metadata?.output || '').trim();
            if (output) {
              const escOutput = escapeHtml(output);
              rendered += `<pre>${escOutput.slice(0, 1000)}</pre>\n\n`;
            }
          } else if (p.type === 'tool_call') {
            const name = p.name || '';
            const input = (p.input || '').trim();
            const escInput = escapeHtml(input);
            rendered += (name === 'bash' || name === 'execute_command' || name === 'run_command')
              ? `<code>$ ${escInput.slice(0, 200)}</code>\n`
              : `⚡ <code>${name}</code>\n`;
          } else if (p.type === 'tool_result') {
            const content = (p.content || '').trim();
            if (content && content.length < 200) rendered += `${escapeHtml(content)}\n`;
          }
        }

        const display = rendered.trim();
        const d = display.length > 3000 ? display.slice(0, 3000) + '\n\n<i>...truncated</i>' : display;

        const finalText = await buildMessageWithHeaderAndFooter(sessionId, d, lastAssistant, promptTimestamp);
        editMessageDirectly(finalText);
        
        // Auto-refresh sessions menus when prompt finishes
        if (lastSessionsMessage) {
          const sessKb = await getSessionsKeyboard(false);
          bot?.editMessageReplyMarkup({ inline_keyboard: sessKb }, { chat_id: lastSessionsMessage.chatId, message_id: lastSessionsMessage.messageId }).catch(() => {});
        }
        if (lastHistoryMessage) {
          const histKb = await getSessionsKeyboard(true);
          bot?.editMessageReplyMarkup({ inline_keyboard: histKb }, { chat_id: lastHistoryMessage.chatId, message_id: lastHistoryMessage.messageId }).catch(() => {});
        }
        await new Promise(r => setTimeout(r, 1500));
      }
    } catch(e) {
      console.error('[Telegram] finalizeTracking error:', e);
    }
  }

  finalizeRef = () => { finalizeTracking().catch(() => {}); };

  tracking.timer = setInterval(async () => {
    try {
      if (tracking.isComplete) return;
      const { activeText, lastAssistant, statusType } = await getSessionActiveContent(sessionId, directory);

      if (statusType === 'idle') {
        await finalizeTracking();
        return;
      }

      const formattedMsg = await buildMessageWithHeaderAndFooter(sessionId, activeText, lastAssistant, promptTimestamp);
      scheduleEdit(formattedMsg);
    } catch (err) {
      console.error('[Telegram] Polling interval error:', err);
    }
  }, 1500);

  setTimeout(() => {
    if (!tracking.isComplete) {
      finalizeTracking().catch(() => {});
    }
  }, 60 * 60 * 1000);
}

export function notifySessionIdle(sessionId: string) {
  const finalize = sessionFinalizers.get(sessionId);
  if (finalize) {
    finalize();
  }
}

export function startTailTracking(
  sessionId: string,
  chatId: number,
  trackingMessageId: number,
  directory: string
) {
  const existingPrompt = activeTrackings.get(sessionId);
  if (existingPrompt && !existingPrompt.isComplete) {
    existingPrompt.isComplete = true;
    if (existingPrompt.timer) clearInterval(existingPrompt.timer);
    activeTrackings.delete(sessionId);
    sessionFinalizers.delete(sessionId);
    
    const finalMsg = existingPrompt.lastText;
    bot?.editMessageText(finalMsg, {
      chat_id: existingPrompt.chatId,
      message_id: existingPrompt.messageId,
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [] }
    }).catch(() => {});
  }

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

  tracking.timer = setInterval(async () => {
    try {
      if (tracking.isComplete) return;
      const { activeText, lastAssistant, statusType, historyMsgs, lastMsgIsAssistant } = await getSessionActiveContent(sessionId, directory);

      let formattedHistory = '';
      const historySlice = historyMsgs.slice(-3);
      for (let i = 0; i < historySlice.length; i++) {
        const m = historySlice[i];
        const role = (m.info || m).role;
        let cleanText = '';
        const isLastHist = (i === historySlice.length - 1);
        
        if (role === 'assistant' && isLastHist) {
          cleanText = buildStatusFromParts(m.parts || []);
        } else {
          const rawText = (m.parts || []).filter((p: any) => p.type === 'text').map((p: any) => p.text || '').join('').trim();
          cleanText = escapeHtml(rawText.length > 300 ? rawText.slice(0, 300) + '...' : rawText);
        }
        
        if (!cleanText) continue;

        if (role === 'user') {
          formattedHistory += `👤 ${cleanText}\n\n`;
        } else if (role === 'assistant') {
          formattedHistory += `🤖 ${cleanText}\n\n`;
        } else {
          formattedHistory += `❓ ${cleanText}\n\n`;
        }
      }

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
  }, 1500);
}

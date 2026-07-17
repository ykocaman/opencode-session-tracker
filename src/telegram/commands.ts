import path from 'path';
import fs from 'fs';
import os from 'os';
import { apiRef, bot, readState, activeProjectDir, setActiveProjectDir, lastProjectsMessage, setLastProjectsMessage, lastSessionsMessage, setLastSessionsMessage, lastHistoryMessage, setLastHistoryMessage } from './state';
import { registerMessageSession, escapeHtml, buildMessageWithHeaderAndFooter } from './formatters';
import { getProjectsKeyboard, getSessionsKeyboard } from './keyboards';
import { startTailTracking } from './tail';

export async function handleStart(chatId: number) {
  bot?.sendMessage(chatId, "👋 Welcome to OpenCode Telegram Integration! Remote session manager is active.");
}

export async function handleProjectsCommand(chatId: number) {
  try {
    const inlineKeyboard = await getProjectsKeyboard();
    const txt = "📁 <b>Projects</b>";

    if (lastProjectsMessage) {
      bot?.editMessageText(txt, {
        chat_id: lastProjectsMessage.chatId,
        message_id: lastProjectsMessage.messageId,
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: inlineKeyboard }
      }).catch(() => {});
    }
    
    const sentMsg = await bot?.sendMessage(chatId, txt, {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: inlineKeyboard
      }
    });
    if (sentMsg) {
       setLastProjectsMessage({ chatId: sentMsg.chat.id, messageId: sentMsg.message_id, timestamp: Date.now() });
    }
  } catch (err) {
    bot?.sendMessage(chatId, "❌ Failed to list projects.").catch(() => {});
  }
}

export async function handleSessionsCommand(chatId: number) {
  try {
    const inlineKeyboard = await getSessionsKeyboard(false);
    const txt = "🗂 <b>Sessions</b>";

    if (lastSessionsMessage) {
      bot?.editMessageText(txt, {
        chat_id: lastSessionsMessage.chatId,
        message_id: lastSessionsMessage.messageId,
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: inlineKeyboard }
      }).catch(() => {});
    }
    
    const sentMsg = await bot?.sendMessage(chatId, txt, {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: inlineKeyboard
      }
    });
    if (sentMsg) {
       setLastSessionsMessage({ chatId: sentMsg.chat.id, messageId: sentMsg.message_id, timestamp: Date.now() });
    }
  } catch (err) {
    bot?.sendMessage(chatId, "❌ Failed to list active sessions.").catch(() => {});
  }
}

export async function handleHistoryCommand(chatId: number) {
  try {
    const inlineKeyboard = await getSessionsKeyboard(true);
    const txt = "📚 <b>Session History</b>";

    if (lastHistoryMessage) {
      bot?.editMessageText(txt, {
        chat_id: lastHistoryMessage.chatId,
        message_id: lastHistoryMessage.messageId,
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: inlineKeyboard }
      }).catch(() => {});
    }
    
    const sentMsg = await bot?.sendMessage(chatId, txt, {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: inlineKeyboard
      }
    });
    if (sentMsg) {
       setLastHistoryMessage({ chatId: sentMsg.chat.id, messageId: sentMsg.message_id, timestamp: Date.now() });
    }
  } catch (err) {
    bot?.sendMessage(chatId, "❌ Failed to list history sessions.").catch(() => {});
  }
}

export async function handleTailCommand(chatId: number, sessionIdParam?: string | null) {
  const targetDir = activeProjectDir || apiRef.state.path.directory;
  let sessionId = sessionIdParam;
  if (!sessionId) {
    try { sessionId = readState().activeSessions?.[targetDir] || null; } catch(e) {}
  }
  if (!sessionId) {
    bot?.sendMessage(chatId, "⚠️ No active session. Use /sessions to select one, or specify a session ID like `/tail [sessionId]`.");
    return;
  }
  
  try {
    const sD = (await apiRef.client.session.get({ sessionID: sessionId }).catch(() => null))?.data || {};
    let title = sD.title || sessionId.slice(0, 8);
    
    const trackingMsg = await bot?.sendMessage(chatId, `📋 <b>Tailing: ${escapeHtml(title)}</b>\n\n⌛ Fetching latest messages...`, {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [[{ text: '❌ Stop Tailing', callback_data: `stop_tracking_${Date.now()}` }]]
      }
    });
    if (!trackingMsg) return;

    // Update Stop Tailing button callback with the correct message_id
    bot?.editMessageReplyMarkup({
      inline_keyboard: [[{ text: '❌ Stop Tailing', callback_data: `stop_tracking_${trackingMsg.message_id}` }]]
    }, { chat_id: chatId, message_id: trackingMsg.message_id }).catch(() => {});

    registerMessageSession(trackingMsg.message_id, sessionId, targetDir);
    startTailTracking(sessionId, chatId, trackingMsg.message_id, targetDir);
  } catch (err) {
    console.error('[Telegram] handleTailCommand error:', err);
    bot?.sendMessage(chatId, "❌ Failed to start tailing. Please make sure the session ID is correct.").catch(() => {});
  }
}

export async function sendRecap(chatId: number, messageId: number | undefined, sessionId: string) {
  try {
    const [msgsRes, sRes] = await Promise.all([
      apiRef.client.session.messages({ sessionID: sessionId, limit: 20 }),
      apiRef.client.session.get({ sessionID: sessionId }).catch(() => null)
    ]);
    const messages = msgsRes?.data || msgsRes || [];
    const msgList = Array.isArray(messages) ? messages : [];
    const sData = sRes?.data || sRes;
    const dir = sData?.directory || apiRef.state.path.directory;

    const assistants = [...msgList].reverse().filter((m: any) => {
      const role = (m.info || m).role;
      return role === "assistant";
    }).slice(0, 2);

    if (assistants.length === 0) return;

    const lastAssistant = assistants[0];
    const prevAssistant = assistants[1];

    const buildAssistantText = (msg: any) =>
      (msg.parts || [])
        .filter((p: any) => p.type === "text")
        .map((p: any) => p.text || "")
        .join("")
        .trim();

    let content = buildAssistantText(lastAssistant);
    if (prevAssistant) {
      const prevText = buildAssistantText(prevAssistant);
      if (prevText) {
        content = `${prevText}\n\n${content}`;
      }
    }

    if (!content) return;

    let userText = '';
    let promptTimestamp = Date.now();
    for (let i = msgList.length - 1; i >= 0; i--) {
      const m = msgList[i];
      if ((m.info || m).role === 'assistant') {
        for (let j = i - 1; j >= 0; j--) {
          const pm = msgList[j];
          if ((pm.info || pm).role === 'user') {
            userText = (pm.content || '').trim() ||
              (pm.parts || [])
                .filter((p: any) => p.type === "text")
                .map((p: any) => p.text || "")
                .join("")
                .trim();
            if (userText) {
              const pTime = pm.time?.created || pm.timeCreated || pm.time?.updated || pm.timeUpdated;
              if (pTime) {
                const num = Number(pTime);
                promptTimestamp = num < 10000000000 ? num * 1000 : num;
              }
            }
            break;
          }
        }
        break;
      }
    }

    const escapedContent = escapeHtml(content).trim();

    const maxLen = 3500;
    let bodyHtml = escapedContent;
    if (userText) {
      const shortUser = escapeHtml(userText.length > 200 ? userText.slice(0, 200) + '...' : userText);
      bodyHtml = `👤 ${shortUser}\n\n${escapedContent}`;
      if (bodyHtml.length > maxLen) {
        const keep = maxLen - `👤 ${shortUser}\n\n`.length - 30;
        bodyHtml = `👤 ${shortUser}\n\n<i>... (truncated) ...</i>\n\n` + escapedContent.slice(-keep);
      }
    } else if (bodyHtml.length > maxLen) {
      bodyHtml = '<i>... (truncated) ...</i>\n\n' + escapedContent.slice(-(maxLen - 30));
    }

    const finalText = await buildMessageWithHeaderAndFooter(sessionId, bodyHtml, lastAssistant, promptTimestamp);

    const replyOpts: any = { parse_mode: 'HTML' };
    if (messageId) replyOpts.reply_to_message_id = messageId;

    const sentMsg = await bot?.sendMessage(chatId, finalText, replyOpts).catch(() => null);
    if (sentMsg) {
      registerMessageSession(sentMsg.message_id, sessionId, dir);
    }
  } catch(e) {}
}

export async function handleHelpCommand(chatId: number) {
  const helpText = `📖 <b>OpenCode Integration Help</b>\n\n` +
    `/projects - List workspace projects\n` +
    `/sessions - List active sessions\n` +
    `/tail - Watch live session execution\n` +
    `/recap - Generate session summary\n` +
    `/models - Switch LLM model\n` +
    `/history - View older sessions`;
  bot?.sendMessage(chatId, helpText, { parse_mode: 'HTML' }).catch(() => {});
}

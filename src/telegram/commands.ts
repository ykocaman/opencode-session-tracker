import path from 'path';
import fs from 'fs';
import os from 'os';
import { apiRef, bot, readState, activeProjectDir, setActiveProjectDir, lastProjectsMessage, setLastProjectsMessage, lastSessionsMessage, setLastSessionsMessage, lastHistoryMessage, setLastHistoryMessage } from './state';
import { registerMessageSession, buildFooter, escapeHtml } from './formatters';
import { getProjectsKeyboard, getSessionsKeyboard } from './keyboards';
import { startTailTracking } from './tracking';

export async function handleStart(chatId: number) {
  bot?.sendMessage(chatId, "👋 Welcome to OpenCode Telegram Companion! Remote session manager is active.");
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

    registerMessageSession(trackingMsg.message_id, sessionId, targetDir);
    startTailTracking(sessionId, chatId, trackingMsg.message_id, targetDir);
  } catch (err) {
    console.error('[Telegram] handleTailCommand error:', err);
    bot?.sendMessage(chatId, "❌ Failed to start tailing. Please make sure the session ID is correct.").catch(() => {});
  }
}

export async function sendAutoRecap(chatId: number, messageId: number | undefined, sessionId: string) {
  try {
    const msgsRes = await apiRef.client.session.messages({ sessionID: sessionId, limit: 10 });
    const messages = msgsRes?.data || msgsRes || [];
    const msgList = Array.isArray(messages) ? messages : [];
    
    const lastAssistant = [...msgList].reverse().find((m: any) => {
      const role = (m.info || m).role;
      return role === "assistant";
    });
    
    if (!lastAssistant) return;
    
    const responseText = (lastAssistant.parts || [])
      .filter((p: any) => p.type === "text")
      .map((p: any) => p.text || "")
      .join("")
      .trim();
    
    if (!responseText) return;
    
    const displayText = responseText.length > 3500 ? responseText.slice(0, 3500) + "\n\n_...truncated_" : responseText;
    
    let footer = "";
    let dir = apiRef.state.path.directory;
    try {
      const sRes = await apiRef.client.session.get({ sessionID: sessionId });
      footer = buildFooter(sRes?.data || sRes);
      if (sRes?.data?.directory || sRes?.directory) {
        dir = sRes.data?.directory || sRes.directory;
      }
    } catch(e) {}
    
    let title = "Session";
    try {
      const sData = (await apiRef.client.session.get({ sessionID: sessionId }))?.data;
      if (sData?.title) title = sData.title;
    } catch(e) {}
    
    const replyOpts: any = { parse_mode: 'Markdown' };
    if (messageId) replyOpts.reply_to_message_id = messageId;
    
    const sentMsg = await bot?.sendMessage(chatId, `📝 **${title}**\n\n${displayText}${footer}`, replyOpts).catch(() => null);
    if (sentMsg) {
      registerMessageSession(sentMsg.message_id, sessionId, dir);
    }
  } catch(e) {}
}

export async function handleHelpCommand(chatId: number) {
  const helpText = `📖 <b>OpenCode Companion Help</b>\n\n` +
    `/projects - List workspace projects\n` +
    `/sessions - List active sessions\n` +
    `/tail - Watch live session execution\n` +
    `/recap - Generate session summary\n` +
    `/models - Switch LLM model\n` +
    `/history - View older sessions`;
  bot?.sendMessage(chatId, helpText, { parse_mode: 'HTML' }).catch(() => {});
}

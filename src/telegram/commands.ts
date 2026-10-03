import path from 'path';
import {
  apiRef, bot, readActiveProjects, lastProjectsMessage, setLastProjectsMessage,
  lastSessionsMessage, setLastSessionsMessage, lastHistoryMessage, setLastHistoryMessage,
  setProjectStatusOverride, clearProjectStatusOverride,
} from './state';
import { registerMessageSession, escapeHtml, buildMessageWithHeaderAndFooter, toMs } from './formatters';
import { getProjectsKeyboard, getSessionsKeyboard } from './keyboards';
import { startTailTracking } from './tail';
import { launchOpenCodeInstance, killOpenCodeInstance } from './launcher';
import { getTargetDir, getActiveSessionId } from './stores';

type MenuMessage = { chatId: number, messageId: number, timestamp: number } | null;

async function refreshProjectsMessage() {
  if (!lastProjectsMessage) return;
  const inlineKeyboard = await getProjectsKeyboard();
  bot?.editMessageReplyMarkup({ inline_keyboard: inlineKeyboard }, {
    chat_id: lastProjectsMessage.chatId,
    message_id: lastProjectsMessage.messageId
  }).catch(() => {});
}

/**
 * Builds a "send a menu" command: refreshes the previous menu message in place (if any),
 * then sends a fresh one and remembers it as the latest.
 */
function createMenuCommand(opts: {
  title: string;
  errorText: string;
  getKeyboard: () => Promise<any[][]>;
  getLast: () => MenuMessage;
  setLast: (msg: MenuMessage) => void;
}) {
  return async (chatId: number) => {
    try {
      const inlineKeyboard = await opts.getKeyboard();
      const last = opts.getLast();

      if (last) {
        bot?.editMessageText(opts.title, {
          chat_id: last.chatId,
          message_id: last.messageId,
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: inlineKeyboard }
        }).catch(() => {});
      }

      const sentMsg = await bot?.sendMessage(chatId, opts.title, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: inlineKeyboard }
      });
      if (sentMsg) {
        opts.setLast({ chatId: sentMsg.chat.id, messageId: sentMsg.message_id, timestamp: Date.now() });
      }
    } catch (err) {
      bot?.sendMessage(chatId, opts.errorText).catch(() => {});
    }
  };
}

export async function handleStart(chatId: number) {
  bot?.sendMessage(chatId, "👋 Welcome to OpenCode Telegram Integration! Remote session manager is active.");
}

export const handleProjectsCommand = createMenuCommand({
  title: "📁 <b>Projects</b>",
  errorText: "❌ Failed to list projects.",
  getKeyboard: getProjectsKeyboard,
  getLast: () => lastProjectsMessage,
  setLast: setLastProjectsMessage,
});

export const handleSessionsCommand = createMenuCommand({
  title: "🗂 <b>Sessions</b>",
  errorText: "❌ Failed to list active sessions.",
  getKeyboard: () => getSessionsKeyboard(false),
  getLast: () => lastSessionsMessage,
  setLast: setLastSessionsMessage,
});

export const handleHistoryCommand = createMenuCommand({
  title: "📚 <b>Session History</b>",
  errorText: "❌ Failed to list history sessions.",
  getKeyboard: () => getSessionsKeyboard(true),
  getLast: () => lastHistoryMessage,
  setLast: setLastHistoryMessage,
});

export async function handleTailCommand(chatId: number, sessionIdParam?: string | null) {
  const targetDir = getTargetDir();
  const sessionId = sessionIdParam || getActiveSessionId(targetDir);
  if (!sessionId) {
    bot?.sendMessage(chatId, "⚠️ No active session. Use /sessions to select one, or specify a session ID like `/tail [sessionId]`.");
    return;
  }

  try {
    const sD = (await apiRef.client.session.get({ sessionID: sessionId }).catch(() => null))?.data || {};
    const title = sD.title || sessionId.slice(0, 8);

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

    const assistants = [...msgList].reverse().filter((m: any) => (m.info || m).role === "assistant").slice(0, 2);

    if (assistants.length === 0) return;

    const lastAssistant = assistants[0];
    const prevAssistant = assistants[1];

    const textOf = (msg: any) =>
      (msg.parts || [])
        .filter((p: any) => p.type === "text")
        .map((p: any) => p.text || "")
        .join("")
        .trim();

    let content = textOf(lastAssistant);
    if (prevAssistant) {
      const prevText = textOf(prevAssistant);
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
            userText = (pm.content || '').trim() || textOf(pm);
            if (userText) {
              promptTimestamp = toMs(pm.time?.created || pm.timeCreated || pm.time?.updated || pm.timeUpdated) || promptTimestamp;
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

export async function handleRestartCommand(chatId: number) {
  const target = getTargetDir();
  if (!target) {
    bot?.sendMessage(chatId, "⚠️ No project selected. Use /projects to select one.").catch(() => {});
    return;
  }
  const dirName = path.basename(target);

  // Set yellow ball to indicate processing
  setProjectStatusOverride(target, 'processing');
  refreshProjectsMessage();

  launchOpenCodeInstance(target, (err) => {
    if (err) {
      clearProjectStatusOverride(target);
      refreshProjectsMessage();
      bot?.sendMessage(chatId, `❌ Launch failed: ${err.message}`).catch(() => {});
      return;
    }
    let attempts = 0;
    const pollTimer = setInterval(() => {
      attempts++;
      const active = readActiveProjects(8000);
      if (active[target]) {
        clearInterval(pollTimer);
        // New instance is online — kill the old one, then clear override
        // so ball turns green (new instance heartbeat is active)
        killOpenCodeInstance(target, process.pid);
        clearProjectStatusOverride(target);
        refreshProjectsMessage();
      } else if (attempts > 30) {
        clearInterval(pollTimer);
        clearProjectStatusOverride(target);
        refreshProjectsMessage();
        bot?.sendMessage(chatId, `⚠️ Timed out waiting for OpenCode to start in ${dirName}`).catch(() => {});
      }
    }, 500);
  });
}

export async function handleHelpCommand(chatId: number) {
  const helpText = `📖 <b>OpenCode Integration Help</b>\n\n` +
    `/projects - List workspace projects\n` +
    `/sessions - List active sessions\n` +
    `/tail - Watch live session execution\n` +
    `/recap - Generate session summary\n` +
    `/models - Switch LLM model\n` +
    `/history - View older sessions\n` +
    `/restart - Restart OpenCode (reloads plugins)`;
  bot?.sendMessage(chatId, helpText, { parse_mode: 'HTML' }).catch(() => {});
}

import TelegramBot from 'node-telegram-bot-api';
import path from 'path';
import {
  apiRef, setActiveProjectDir,
  lastSessionsMessage, setLastSessionsMessage, lastProjectsMessage, lastHistoryMessage, setLastHistoryMessage,
} from '../core/runtime';
import { readState } from '../core/store';
import { readActiveProjects } from '../core/leader';
import { saveSessionModel } from '../core/status';
import { setProjectStatusOverride, clearProjectStatusOverride } from '../core/store';
import { escapeHtml } from './formatters';
import { getProjectsKeyboard, getSessionsKeyboard, projectIds, modelIds } from './keyboards';
import { activeTails } from './tail';
import { handleSessionsCommand, handleHistoryCommand, handleTailCommand, sendRecap } from './commands';
import { launchOpenCodeInstance, killOpenCodeInstance } from './launcher';
import { getModelsKeyboard } from './models';
import { sendQuestionMessage, answerQuestionFlow, cancelQuestionFlow, findFlow } from './forms';
import { permissionRequests, getTargetDir, getActiveSessionId, setActiveSessionId } from '../core/context';
import { enqueue } from '../core/queue';
import { pendingPermissions } from '../core/ctx';

type Query = TelegramBot.CallbackQuery & { message: TelegramBot.Message; data: string };
type Handler = (bot: TelegramBot, query: Query) => Promise<void> | void;

const answer = (bot: TelegramBot, query: Query, text: string) =>
  bot.answerCallbackQuery(query.id, { text });

function refreshKeyboard(bot: TelegramBot, chatId: number, messageId: number, kb: any[][]) {
  return bot.editMessageReplyMarkup({ inline_keyboard: kb }, { chat_id: chatId, message_id: messageId }).catch(() => {});
}

function refreshProjectsKeyboard(bot: TelegramBot, chatId: number, messageId: number) {
  return getProjectsKeyboard().then(kb => refreshKeyboard(bot, chatId, messageId, kb));
}

/** Re-renders (or re-sends, if it can't be edited) a /sessions or /history menu after a project change. */
async function refreshStaleMenu(
  bot: TelegramBot,
  chatId: number,
  menu: { chatId: number; messageId: number; timestamp: number } | null,
  isHistory: boolean,
  clear: () => void,
  resend: (chatId: number) => Promise<unknown>,
) {
  if (!menu || menu.chatId !== chatId || !lastProjectsMessage || menu.timestamp <= lastProjectsMessage.timestamp) return;
  const kb = await getSessionsKeyboard(isHistory);
  try {
    await bot.editMessageReplyMarkup({ inline_keyboard: kb }, { chat_id: menu.chatId, message_id: menu.messageId });
  } catch (e) {
    bot.deleteMessage(menu.chatId, menu.messageId).catch(() => {});
    clear();
    await resend(chatId);
  }
}

const onNavigate: Handler = async (bot, query) => {
  const isSessionsMsg = !!lastSessionsMessage && query.message.message_id === lastSessionsMessage.messageId;
  const isHistoryMsg = !!lastHistoryMessage && query.message.message_id === lastHistoryMessage.messageId;
  if (!isSessionsMsg && !isHistoryMsg) {
    answer(bot, query, 'Menu outdated. Send /sessions or /history again.');
    return;
  }
  const targetId = query.data.replace('nav_', '');
  const sId = targetId === 'home' ? null : targetId;
  const targetDir = getTargetDir();
  try {
    enqueue({ type: 'navigate', targetDir, sessionId: sId });
    setActiveSessionId(targetDir, sId);

    answer(bot, query, 'Session switched.');

    try {
      const menu = isSessionsMsg ? lastSessionsMessage! : lastHistoryMessage!;
      const kb = await getSessionsKeyboard(!isSessionsMsg);
      refreshKeyboard(bot, menu.chatId, menu.messageId, kb);
    } catch (e) {}
  } catch (e) {
    answer(bot, query, 'Failed to navigate');
  }
};

const onProjectSelect: Handler = async (bot, query) => {
  if (lastProjectsMessage && query.message.message_id !== lastProjectsMessage.messageId) {
    answer(bot, query, 'Menu outdated. Send /projects again.');
    return;
  }
  const targetDir = projectIds.get(query.data.replace('proj_select_', ''));
  if (!targetDir) {
    answer(bot, query, 'Project not found. Run /projects again.');
    return;
  }
  setActiveProjectDir(targetDir);
  answer(bot, query, `Project selected: ${path.basename(targetDir)}`);
  const chatId = query.message.chat.id;
  try {
    await refreshProjectsKeyboard(bot, chatId, query.message.message_id);
    await refreshStaleMenu(bot, chatId, lastSessionsMessage, false, () => setLastSessionsMessage(null), handleSessionsCommand);
    await refreshStaleMenu(bot, chatId, lastHistoryMessage, true, () => setLastHistoryMessage(null), handleHistoryCommand);
  } catch (e) {}
};

const onProjectLaunch: Handler = (bot, query) => {
  const currentSelected = getTargetDir();
  if (!currentSelected) {
    answer(bot, query, 'No project selected.');
    return;
  }
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  answer(bot, query, `Launching OpenCode in ${path.basename(currentSelected)}...`);

  launchOpenCodeInstance(currentSelected, (err) => {
    if (err) {
      console.error('[Telegram] Failed to launch project CLI:', err);
      bot.sendMessage(chatId, `❌ Failed to launch OpenCode: ${escapeHtml(err.message)}`).catch(() => {});
      return;
    }
    let attempts = 0;
    const pollTimer = setInterval(async () => {
      attempts++;
      if (readActiveProjects(8000)[currentSelected]) {
        clearInterval(pollTimer);
        refreshProjectsKeyboard(bot, chatId, messageId);
      } else if (attempts > 30) {
        clearInterval(pollTimer);
      }
    }, 500);
  });
};

const onProjectListSessions: Handler = async (bot, query) => {
  answer(bot, query, 'Listing sessions...');
  await handleSessionsCommand(query.message.chat.id);
};

const onProjectClose: Handler = (bot, query) => {
  if (lastProjectsMessage && query.message.message_id !== lastProjectsMessage.messageId) {
    answer(bot, query, 'Menu outdated. Send /projects again.');
    return;
  }
  const chatId = query.message.chat.id;
  const msgId = query.message.message_id;
  const target = getTargetDir();
  if (!target) {
    answer(bot, query, 'No project selected.');
    return;
  }
  const active = readActiveProjects(15000);
  if (!active[target]) {
    answer(bot, query, `⚠️ No active instance for ${path.basename(target)}`);
    refreshProjectsKeyboard(bot, chatId, msgId);
    return;
  }
  if (Object.keys(active).length <= 1) {
    answer(bot, query, '⚠️ Last active instance. Cannot close.');
    return;
  }
  answer(bot, query, `Closing ${path.basename(target)}...`);
  const result = killOpenCodeInstance(target, process.pid);
  if (result.killed) {
    setProjectStatusOverride(target, 'closing');
    refreshProjectsKeyboard(bot, chatId, msgId);
    setTimeout(() => {
      clearProjectStatusOverride(target);
      refreshProjectsKeyboard(bot, chatId, msgId);
    }, 10000);
  } else {
    answer(bot, query, result.message);
  }
};

/** Wraps handlers that need an active session selected. */
const withActiveSession = (
  fn: (bot: TelegramBot, query: Query, sessionId: string) => Promise<void> | void,
): Handler => (bot, query) => {
  const sessionId = getActiveSessionId();
  if (!sessionId) {
    answer(bot, query, 'No active session selected.');
    return;
  }
  return fn(bot, query, sessionId);
};

const onSessionTail = withActiveSession(async (bot, query, sessionId) => {
  answer(bot, query, 'Starting tailing...');
  await handleTailCommand(query.message.chat.id, sessionId);
});

const onSessionRecap = withActiveSession(async (bot, query, sessionId) => {
  answer(bot, query, 'Generating recap...');
  await sendRecap(query.message.chat.id, undefined, sessionId);
});

const onShowQuestion = withActiveSession((bot, query, sessionId) => {
  const flow = findFlow(f => f.sessionId === sessionId);
  if (flow) {
    answer(bot, query, 'Resending question...');
    sendQuestionMessage(flow);
    return;
  }

  const perm = permissionRequests.entries().find(([, req]) => req.sessionId === sessionId);
  if (!perm) {
    answer(bot, query, 'No active question or permission request found.');
    return;
  }

  answer(bot, query, 'Resending permission request...');
  let desc = 'Session needs permission to execute a tool.';
  try {
    const p = pendingPermissions(sessionId);
    if (p && p.length > 0) {
      const first = p[0];
      desc = first.message || (first.action ? `${first.action}: ${(first.resources || []).join(', ')}` : desc);
    }
  } catch (e) {}

  const shortId = perm[0];
  bot.sendMessage(query.message.chat.id, `⚠️ **Permission Request**\n\n${escapeHtml(desc)}`, {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [[
        { text: '✅ Allow', callback_data: `perm_allow_${shortId}` },
        { text: '❌ Deny', callback_data: `perm_deny_${shortId}` },
      ]],
    },
  }).catch(() => {});
});

const onStopTracking: Handler = (bot, query) => {
  const msgId = parseInt(query.data.replace('stop_tracking_', ''), 10);
  const chatId = query.message.chat.id;

  const tailTracking = activeTails.get(msgId);
  if (tailTracking) {
    tailTracking.isComplete = true;
    if (tailTracking.timer) clearInterval(tailTracking.timer);
    activeTails.delete(msgId);

    answer(bot, query, 'Tailing stopped.');
    bot.editMessageText(tailTracking.lastText, {
      chat_id: chatId,
      message_id: msgId,
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [] },
    }).catch(() => {});
    return;
  }

  answer(bot, query, 'Tailing already stopped or expired.');
  bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: query.message.message_id }).catch(() => {});
};

const onPermission: Handler = async (bot, query) => {
  const isAllow = query.data.startsWith('perm_allow_');
  const shortId = query.data.replace(isAllow ? 'perm_allow_' : 'perm_deny_', '');
  const req = permissionRequests.get(shortId);

  if (!req) {
    answer(bot, query, 'Permission request expired or invalid.');
    return;
  }

  try {
    await apiRef.client.permission.reply({
      sessionID: req.sessionId,
      requestID: req.permId,
      decision: isAllow ? 'once' : 'reject',
    });
    answer(bot, query, isAllow ? '✅' : '❌');
    permissionRequests.delete(shortId);

    bot.editMessageText(query.message.text + `\n\n_Decision: ${isAllow ? 'Allowed ✅' : 'Denied ❌'}_`, {
      chat_id: query.message.chat.id,
      message_id: query.message.message_id,
      reply_markup: { inline_keyboard: [] },
    }).catch(() => {});
  } catch (e) {
    answer(bot, query, 'Error replying to permission request.');
  }
};

const onQuestionAnswer: Handler = (bot, query) => {
  const msgId = query.message.message_id;
  const chatId = query.message.chat.id;

  // Prefer a (chat, message) match; fall back to message id alone (multi-user edge case)
  const flow = findFlow(f => f.messageId === msgId && f.chatId === chatId) || findFlow(f => f.messageId === msgId);
  if (!flow) {
    answer(bot, query, 'Question expired.');
    return;
  }

  if (query.data === 'q_cancel') {
    answer(bot, query, 'Question cancelled.');
    cancelQuestionFlow(flow);
    return;
  }

  const ans = query.data.replace('q_ans_', '');
  answer(bot, query, `✅ ${ans}`);
  answerQuestionFlow(flow, ans);
};

const onModelSelect: Handler = async (bot, query) => {
  const hash = query.data.replace('model_select_', '');
  const ref = modelIds.get(hash);
  if (!ref) {
    // Stale menu: hashes live in memory and are lost on restart. Self-heal
    // with a fresh list instead of guessing the provider (the old code
    // re-parsed the id string and defaulted to openrouter — that switched
    // sessions to a non-existent model).
    answer(bot, query, 'Menu outdated, fresh list sent.');
    try {
      const kb = await getModelsKeyboard();
      await bot?.sendMessage(query.message.chat.id, '🤖 <b>Models</b>', {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: kb },
      });
    } catch {}
    return;
  }

  const { providerID, modelID } = ref;
  const targetDir = getTargetDir();
  const currentActive = getActiveSessionId(targetDir);

  if (currentActive) {
    try {
      enqueue({ type: 'model_change', targetDir, sessionId: currentActive, providerID, modelID });
      saveSessionModel(currentActive, providerID, modelID);
    } catch (e) {}
  }

  try {
    const kb = await getModelsKeyboard();
    refreshKeyboard(bot, query.message.chat.id, query.message.message_id, kb);
  } catch (e) {}

  answer(bot, query, `✅ Model: ${modelID}`);
};

const exactHandlers: Record<string, Handler> = {
  proj_launch: onProjectLaunch,
  proj_list_sessions: onProjectListSessions,
  proj_close: onProjectClose,
  sess_tail: onSessionTail,
  sess_recap: onSessionRecap,
  sess_show_question: onShowQuestion,
  q_cancel: onQuestionAnswer,
};

const prefixHandlers: [string, Handler][] = [
  ['nav_', onNavigate],
  ['proj_select_', onProjectSelect],
  ['stop_tracking_', onStopTracking],
  ['perm_allow_', onPermission],
  ['perm_deny_', onPermission],
  ['q_ans_', onQuestionAnswer],
  ['model_select_', onModelSelect],
];

export function registerCallbackHandler(bot: TelegramBot, isAllowed: (userId: number) => boolean) {
  bot.on('callback_query', async (raw) => {
    if (!raw.from || !isAllowed(raw.from.id) || !raw.message || !raw.data) return;
    const query = raw as Query;

    const handler = exactHandlers[query.data] || prefixHandlers.find(([prefix]) => query.data.startsWith(prefix))?.[1];
    await handler?.(bot, query);
  });
}

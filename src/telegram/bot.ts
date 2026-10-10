// Telegram bot lifecycle + incoming messages.
//
// Hot-reload contract (saga lesson, do not regress): the polling bot
// survives reloads on globalThis; module state does not. startTelegramBot
// therefore reloads allowedUsers from disk BEFORE the `if (bot) return`
// early-return — otherwise every notify and every incoming message is
// silently dropped after a reload.
import TelegramBot from 'node-telegram-bot-api';
import {
  bot, setBot, apiRef, allowedUsers, setAllowedUsers, isLeader,
  loadConfig,
} from '../core/runtime';
import { storeSet, storeGet, setTelegramStatus, cleanupStaleCacheFiles } from '../core/store';
import { registerMessageSession, escapeHtml } from './formatters';
import { startTailTracking, activeTails } from './tail';
import {
  handleStart, handleProjectsCommand, handleSessionsCommand, handleHistoryCommand,
  handleTailCommand, sendRecap, handleHelpCommand, handleRestartCommand,
} from './commands';
import { registerCallbackHandler } from './callbacks';
import { handleModelsCommand } from './models';
import { answerQuestionFlow, findFlow } from './forms';
import {
  pendingQuestions, getTargetDir, getActiveSessionId, setActiveSessionId,
  buildPromptOpts, updateCurrentSessionId,
} from '../core/context';
import { navigateSession, unwrapSessionId, workdir } from '../core/ctx';
import { enqueue, reportError } from '../core/queue';

export function stopTelegramBot() {
  if (bot) {
    try {
      bot.stopPolling();
    } catch {}
    setBot(null);
  }
  for (const [, tail] of activeTails.entries()) {
    try {
      tail.isComplete = true;
      if (tail.timer) clearInterval(tail.timer);
    } catch {}
  }
  activeTails.clear();
}

export function startTelegramBot() {
  const config = loadConfig();
  if (!config) {
    setTelegramStatus('missing');
    return;
  }
  // MUST run before the early return: module state resets on hot reload
  // while the bot survives on globalThis.
  setAllowedUsers(config.allowedUsers || []);
  if (bot) return;

  cleanupStaleCacheFiles();
  setTelegramStatus('ok');
  const newBot = new TelegramBot(config.token, {
    polling: true,
    // Long-poll requests use a keep-alive socket with no client-side timeout by default.
    // After a network drop the socket can go stale and hang forever with no
    // error/retry, silently killing the bot until restart. A request timeout
    // comfortably above the server-side long-poll wait lets stale sockets get
    // aborted and the polling loop recover on its own.
    request: { timeout: 30000 } as any
  } as TelegramBot.ConstructorOptions);
  setBot(newBot);
  newBot.on('polling_error', (e) => console.error('[Telegram] polling error:', e?.message || e));
  newBot.on('error', (e) => {
    console.error('[Telegram] bot error:', e?.message || e);
    try {
      newBot.stopPolling();
    } catch {}
    setBot(null);
  });
  newBot.setMyCommands([
    { command: 'projects', description: 'List projects' },
    { command: 'sessions', description: 'List sessions' },
    { command: 'tail', description: 'Tail the active session' },
    { command: 'recap', description: 'Recap the active session' },
    { command: 'models', description: 'List models' },
    { command: 'help', description: 'Show help' },
  ]).catch(() => {});
  registerCallbackHandler(newBot, (userId: number) => allowedUsers.includes(userId));
  newBot.on('message', (msg) => {
    void onMessage(newBot, msg);
  });
}

export interface NotifyResult {
  ok: boolean;
  reason?: string;
  timestamp: number;
}

function recordNotify(ok: boolean, reason?: string) {
  storeSet('lastNotify', { ok, reason, timestamp: Date.now() } satisfies NotifyResult);
}

/** Leader-only outbound send. Never throws; result observable via lastNotify. */
export async function notifyTelegram(message: string, inlineOptions?: { text: string; callback_data: string }[]) {
  if (!isLeader) return recordNotify(false, 'not-leader');
  if (!bot) return recordNotify(false, 'no-bot');
  if (allowedUsers.length === 0) return recordNotify(false, 'no-users');
  let ok = true;
  let reason: string | undefined;
  const opts: any = { parse_mode: 'HTML' };
  if (inlineOptions) opts.reply_markup = { inline_keyboard: [inlineOptions] };
  for (const userId of allowedUsers) {
    try {
      await bot.sendMessage(userId, message, opts);
    } catch (e: any) {
      ok = false;
      reason = String(e?.message || e).slice(0, 200);
    }
  }
  recordNotify(ok, reason);
}

export function lastNotify(): NotifyResult | null {
  try {
    return storeGet<NotifyResult | null>('lastNotify', null);
  } catch {
    return null;
  }
}

// --- Incoming ---

async function onMessage(b: TelegramBot, msg: TelegramBot.Message) {
  try {
    if (!msg.from || !allowedUsers.includes(msg.from.id) || !msg.text) return;
    const text = msg.text.trim();
    if (text.startsWith('/')) return handleCommand(msg.chat.id, text);
    let replySessionId: string | null = null;
    let replyDir: string | null = null;
    if (msg.reply_to_message) {
      try {
        const mapped = storeGet<Record<string, { sessionId: string; directory: string }>>('messageSessions', {})[
          msg.reply_to_message.message_id
        ];
        if (mapped) {
          replySessionId = mapped.sessionId;
          replyDir = mapped.directory;
        }
      } catch {}
    }
    await handleIncomingText(msg.chat.id, text, replySessionId, replyDir, msg.message_id);
  } catch (e) {
    console.error('[Telegram] onMessage error:', e);
  }
}

async function handleCommand(chatId: number, text: string) {
  const [rawCmd, arg] = text.split(' ');
  switch (rawCmd.toLowerCase()) {
    case '/start': return handleStart(chatId);
    case '/projects': return handleProjectsCommand(chatId);
    case '/sessions': return handleSessionsCommand(chatId);
    case '/models': return handleModelsCommand(chatId, arg || undefined);
    case '/recap': return handleRecapCommand(chatId);
    case '/history': return handleHistoryCommand(chatId);
    case '/tail': return handleTailCommand(chatId, arg ?? null);
    case '/restart': return handleRestartCommand(chatId);
    case '/help': return handleHelpCommand(chatId);
  }
}

async function handleRecapCommand(chatId: number) {
  const currentActive = getActiveSessionId();
  if (!currentActive) {
    bot?.sendMessage(chatId, '⚠️ No active session to recap. Start a session or use /sessions to select one.');
    return;
  }
  await sendRecap(chatId, undefined, currentActive);
}

/**
 * Sends the prompt to the session: directly when this instance owns the
 * directory, otherwise as a durable queue job for the owning instance.
 * Throws on local failure so the caller can tell the user.
 */
async function dispatchPrompt(sessionId: string, targetDir: string, text: string) {
  if (targetDir === workdir()) {
    navigateSession(sessionId);
    await apiRef.client.session.prompt(buildPromptOpts(sessionId, text));
  } else {
    enqueue({ type: 'prompt', targetDir, sessionId, text });
  }
}

/** Stops live tails of a session so a fresh reply-mode stream can start. */
function closeActiveTails(sessionId: string) {
  for (const [msgId, tail] of activeTails.entries()) {
    if (tail.sessionId !== sessionId || tail.isComplete) continue;
    tail.isComplete = true;
    if (tail.timer) clearInterval(tail.timer);
    activeTails.delete(msgId);
    bot?.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: tail.chatId, message_id: msgId }).catch(() => {});
  }
}

async function handleIncomingText(
  chatId: number,
  text: string,
  replySessionId: string | null,
  replyDir: string | null,
  userMsgId?: number,
) {
  const targetDir = replyDir || getTargetDir();
  let currentActive: string | null;

  if (replySessionId && replyDir) {
    currentActive = replySessionId;
    updateCurrentSessionId(replySessionId);
    try {
      setActiveSessionId(replyDir, replySessionId);
    } catch {}
  } else if (replySessionId) {
    currentActive = replySessionId;
  } else {
    currentActive = getActiveSessionId(targetDir);
  }

  // A pending question for this session takes the text as its answer.
  if (currentActive) {
    const qId = pendingQuestions.get(currentActive);
    const flow = qId ? findFlow((f) => f.requestId === qId) : null;
    if (flow) {
      answerQuestionFlow(flow, text);
      return;
    }
    closeActiveTails(currentActive);
  }

  const sentMsg = await bot?.sendMessage(chatId, '⏳', userMsgId ? { reply_to_message_id: userMsgId } : {}).catch(() => null);
  if (!sentMsg) return;
  const tailMsgId = sentMsg.message_id;

  bot?.editMessageReplyMarkup(
    { inline_keyboard: [[{ text: '❌ Stop Tracking', callback_data: `stop_tracking_${tailMsgId}` }]] },
    { chat_id: chatId, message_id: tailMsgId },
  ).catch(() => {});

  if (currentActive) {
    registerMessageSession(tailMsgId, currentActive, targetDir);
    try {
      await dispatchPrompt(currentActive, targetDir, text);
    } catch (e: any) {
      reportError('send prompt', e);
      bot?.sendMessage(chatId, `❌ Failed to send prompt: ${escapeHtml(e?.message || e)}`).catch(() => {});
      return;
    }
    startTailTracking(currentActive, chatId, tailMsgId, targetDir);
    return;
  }

  try {
    const createRes: any = await apiRef.client.session.create({ location: { directory: targetDir } });
    const newSessionId = unwrapSessionId(createRes);
    if (!newSessionId) {
      bot?.sendMessage(chatId, '❌ Could not create a session.').catch(() => {});
      return;
    }
    updateCurrentSessionId(newSessionId);
    setActiveSessionId(targetDir, newSessionId);
    registerMessageSession(tailMsgId, newSessionId, targetDir);
    try {
      await dispatchPrompt(newSessionId, targetDir, text);
    } catch (e: any) {
      reportError('send prompt', e);
      bot?.sendMessage(chatId, `❌ Failed to send prompt: ${escapeHtml(e?.message || e)}`).catch(() => {});
      return;
    }
    startTailTracking(newSessionId, chatId, tailMsgId, targetDir);
  } catch (e: any) {
    reportError('create session', e);
    bot?.sendMessage(chatId, `❌ Failed to create session: ${escapeHtml(e?.message || e)}`).catch(() => {});
  }
}

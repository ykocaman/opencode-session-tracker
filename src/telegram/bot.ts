import TelegramBot from 'node-telegram-bot-api';
import {
  bot, setBot, apiRef, allowedUsers, setAllowedUsers, setSelectedModel, isLeader,
  readState, loadConfig, updateState, cleanupStaleCacheFiles,
} from './state';
import { registerMessageSession, escapeHtml } from './formatters';
import { startTailTracking, activeTails } from './tail';
import {
  handleStart, handleProjectsCommand, handleSessionsCommand, handleHistoryCommand,
  handleTailCommand, sendRecap, handleHelpCommand, handleRestartCommand,
} from './commands';
import { registerCallbackHandler } from './callbacks';
import { handleModelsCommand } from './models';
import { answerQuestionFlow, findFlow } from './questions';
import {
  pendingQuestions, getTargetDir, getActiveSessionId, setActiveSessionId,
  getSelectedModelRef, buildPromptOpts, updateCurrentSessionId,
} from './stores';

export function stopTelegramBot() {
  if (bot) {
    try { bot.stopPolling(); } catch (e) {}
    setBot(null);
  }
  for (const tracking of activeTails.values()) {
    tracking.isComplete = true;
    if (tracking.timer) clearInterval(tracking.timer);
  }
  activeTails.clear();
}

export function notifyTelegram(message: string, inlineOptions?: { text: string, callback_data: string }[]) {
  if (!isLeader || !bot || allowedUsers.length === 0) return;
  const opts: any = {};
  if (inlineOptions && inlineOptions.length > 0) {
    opts.reply_markup = { inline_keyboard: [inlineOptions] };
  }
  allowedUsers.forEach(userId => {
    bot?.sendMessage(userId, message, opts);
  });
}

export function startTelegramBot() {
  if (bot) return;
  const config = loadConfig();
  if (!config) {
    updateState('telegramStatus', 'missing');
    return;
  }

  cleanupStaleCacheFiles();
  updateState('telegramStatus', 'ok');

  setAllowedUsers(config.allowedUsers);

  const state = readState();
  if (state.sync?.model) {
    setSelectedModel(state.sync.model);
  }

  const newBot = new TelegramBot(config.token, {
    polling: true,
    // Long-poll requests use a keep-alive socket with no client-side timeout by default.
    // After a network drop (Wi-Fi handoff, sleep/wake, VPN toggle) the socket can go stale
    // and hang forever with no error/retry, silently killing the bot until OpenCode restarts.
    // A request timeout comfortably above the server-side long-poll wait (10s) lets stale
    // sockets get aborted and the polling loop recover on its own.
    request: { timeout: 30000 } as any
  } as TelegramBot.ConstructorOptions);
  setBot(newBot);

  newBot.on('polling_error', (err: any) => {
    console.error('[Telegram] Polling error:', err?.message || err);
  });
  newBot.on('error', (err: any) => {
    console.error('[Telegram] Bot error:', err?.message || err);
    try { newBot.stopPolling(); } catch (e) {}
    setBot(null);
  });

  newBot.setMyCommands([
    { command: 'projects', description: 'List workspace projects' },
    { command: 'sessions', description: 'List active sessions' },
    { command: 'tail', description: 'Watch live session stream' },
    { command: 'recap', description: 'Generate session summary' },
    { command: 'models', description: 'Switch LLM model' },
    { command: 'help', description: 'Show command list help' }
  ]).catch(() => {});

  registerCallbackHandler(newBot, (userId) => allowedUsers.includes(userId));

  newBot.on('message', async (msg) => {
    if (!msg.from || !allowedUsers.includes(msg.from.id) || !msg.text) return;
    const text = msg.text.trim();

    if (text.startsWith('/')) {
      await handleCommand(msg.chat.id, text);
      return;
    }

    // Check if this is a reply to a known session message
    let replySessionId: string | null = null;
    let replyDir: string | null = null;
    if (msg.reply_to_message) {
      try {
        const mapped = readState().messageSessions?.[msg.reply_to_message.message_id];
        if (mapped) {
          replySessionId = mapped.sessionId;
          replyDir = mapped.directory;
        }
      } catch (e) {}
    }

    await handleIncomingText(msg.chat.id, text, replySessionId, replyDir, msg.message_id);
  });
}

async function handleCommand(chatId: number, text: string) {
  const [rawCmd, arg] = text.split(' ');
  switch (rawCmd.toLowerCase()) {
    case '/start': return handleStart(chatId);
    case '/projects': return handleProjectsCommand(chatId);
    case '/sessions': return handleSessionsCommand(chatId);
    case '/models': return handleModelsCommand(chatId);
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
    bot?.sendMessage(chatId, "⚠️ No active session to recap. Start a session or use /sessions to select one.");
    return;
  }
  await sendRecap(chatId, undefined, currentActive);
}

/** Sends the prompt to the session, either locally or via the sync channel to the owning instance. */
function dispatchPrompt(sessionId: string, targetDir: string, text: string) {
  if (targetDir === apiRef.state.path.directory) {
    apiRef.route.navigate("session", { sessionID: sessionId });
    apiRef.client.session.prompt(buildPromptOpts(sessionId, text)).catch(() => {});
  } else {
    updateState('sync', {
      type: 'prompt',
      targetDir,
      sessionId,
      text,
      model: getSelectedModelRef(),
      timestamp: Date.now()
    });
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
  userMsgId?: number
) {
  const targetDir = replyDir || getTargetDir();
  let currentActive: string | null;

  if (replySessionId && replyDir) {
    currentActive = replySessionId;
    updateCurrentSessionId(replySessionId);
    try { setActiveSessionId(replyDir, replySessionId); } catch (e) {}
  } else if (replySessionId) {
    currentActive = replySessionId;
  } else {
    currentActive = getActiveSessionId(targetDir);
  }

  // A pending question for this session takes the text as its answer
  if (currentActive) {
    const qId = pendingQuestions.get(currentActive);
    const flow = qId ? findFlow(f => f.requestId === qId) : null;
    if (flow) {
      answerQuestionFlow(flow, text);
      return;
    }
    closeActiveTails(currentActive);
  }

  // Create a new tail message in reply to the user's prompt
  const sentMsg = await bot?.sendMessage(chatId, "⏳", userMsgId ? { reply_to_message_id: userMsgId } : {}).catch(() => null);
  if (!sentMsg) return;
  const tailMsgId = sentMsg.message_id;

  bot?.editMessageReplyMarkup({
    inline_keyboard: [[{ text: '❌ Stop Tracking', callback_data: `stop_tracking_${tailMsgId}` }]]
  }, { chat_id: chatId, message_id: tailMsgId }).catch(() => {});

  if (currentActive) {
    registerMessageSession(tailMsgId, currentActive, targetDir);
    dispatchPrompt(currentActive, targetDir, text);
    startTailTracking(currentActive, chatId, tailMsgId, targetDir);
    return;
  }

  try {
    const createRes: any = await apiRef.client.session.create({ directory: targetDir });
    const newSessionId = createRes.data?.id || createRes.id;
    if (!newSessionId) return;

    updateCurrentSessionId(newSessionId);
    setActiveSessionId(targetDir, newSessionId);
    registerMessageSession(tailMsgId, newSessionId, targetDir);
    dispatchPrompt(newSessionId, targetDir, text);
    startTailTracking(newSessionId, chatId, tailMsgId, targetDir);
  } catch (e: any) {
    bot?.sendMessage(chatId, `❌ Failed to create session: ${escapeHtml(e.message)}`).catch(() => {});
  }
}

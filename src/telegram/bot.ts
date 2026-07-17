import TelegramBot from 'node-telegram-bot-api';
import fs from 'fs';
import path from 'path';
import { 
  bot, setBot, apiRef, setApiRef, allowedUsers, setAllowedUsers, selectedModel, setSelectedModel, 
  activeProjectDir, setActiveProjectDir, isLeader, setIsLeader, leaderInterval, setLeaderInterval, 
  STATE_DIR, LOCK_FILE, STATE_FILE, readState, writeState, updateState, loadConfig, updateActiveProjects, cleanupStaleCacheFiles,
  lastSessionsMessage, setLastSessionsMessage, lastProjectsMessage, setLastProjectsMessage, lastHistoryMessage, setLastHistoryMessage,
  sessionFinalizers, saveSessionModel
} from './state';
import { registerMessageSession, escapeHtml } from './formatters';
import { getProjectsKeyboard, getSessionsKeyboard, projectIds, sessionIds, modelIds, getSessionStatus } from './keyboards';
import { startPollingPrompt, startTailTracking, ActiveTracking, TailTracking } from './tracking';
import { handleStart, handleProjectsCommand, handleSessionsCommand, handleHistoryCommand, handleTailCommand, sendAutoRecap, handleHelpCommand } from './commands';
import { launchOpenCodeInstance } from './launcher';

export const activeTrackings = new Map<string, ActiveTracking>();
export const activeTails = new Map<number, TailTracking>();
export const permissionRequests = new Map<string, { sessionId: string, permId: string }>();
export const pendingQuestions = new Map<string, string>();

let lastCreatedTimestamp = 0;
let lastSyncTimestamp = 0;
let lastMenuUpdateTimestamp = 0;

// Interactive question flow system
export interface QuestionFlow {
  requestId: string;
  sessionId: string;
  questions: any[];
  currentIndex: number;
  messageId?: number;
  chatId?: number;
  title: string;
}
export const qfMap = new Map<string, QuestionFlow>();

export function registerQuestionRequest(sessionId: string, requestId: string) {
    pendingQuestions.set(sessionId, requestId);
}

export function registerPermissionRequest(sessionId: string, permId: string): string {
    const shortId = Math.random().toString(36).substring(2, 10);
    permissionRequests.set(shortId, { sessionId, permId });
    return shortId;
}

export function updateCurrentSessionId(id: string | null) {
  if (id === null) return;
  const dir = apiRef?.state?.path?.directory;
  if (dir) {
      try {
          const state = readState();
          const activeSessions = state.activeSessions || {};
          if (activeSessions[dir] !== id) {
             activeSessions[dir] = id;
             state.activeSessions = activeSessions;
             writeState(state);
             triggerSessionsMenuUpdate();
          }
      } catch(e) {}
  }
}

async function triggerSessionsMenuUpdate() {
  updateState('menuUpdateTimestamp', Date.now());
}

export function notifyTelegramQuestion(requestId: string, sessionId: string, questions: any[], title: string) {
    const q = questions[0];
    let msg = `⚠️ **Question Asked**\nSeans \`${title}\` needs your input!\n\n**${q.question}**`;
    if (questions.length > 1) {
       msg += ` *(Question 1 of ${questions.length})*`;
    }
    
    const inlineKeyboard: any[][] = [];
    if (q.type === 'multiple-choice' && Array.isArray(q.options)) {
        q.options.forEach((opt: string) => {
            inlineKeyboard.push([{ text: opt, callback_data: `q_ans_${opt.slice(0, 30)}` }]);
        });
    }
    inlineKeyboard.push([{ text: "❌ Skip/Cancel", callback_data: "q_cancel" }]);
    
  const flow: QuestionFlow = {
    requestId,
    sessionId,
    questions,
    currentIndex: 0,
    title
  };
  qfMap.set(requestId, flow);
  sendQuestionMessage(flow);
}

function sendQuestionMessage(flow: QuestionFlow) {
  const q = flow.questions[flow.currentIndex];
  let inlineKeyboard: any[][] = [];
  if (q.type === 'multiple-choice' && Array.isArray(q.options)) {
      q.options.forEach((opt: string) => {
          inlineKeyboard.push([{ text: opt, callback_data: `q_ans_${opt.slice(0, 30)}` }]);
      });
  }
  inlineKeyboard.push([{ text: "❌ Skip/Cancel", callback_data: "q_cancel" }]);
  
  const num = flow.questions.length > 1 ? ` *(${flow.currentIndex + 1}/${flow.questions.length})*` : '';
  const msg = `📌 *${flow.title}*${num}\n\n${q.question}`;
  
  allowedUsers.forEach(async (userId) => {
      try {
        const sent = await bot?.sendMessage(userId, msg, {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: inlineKeyboard }
        });
        if (sent) {
           flow.messageId = sent.message_id;
           flow.chatId = sent.chat.id;
        }
      } catch(e) {}
  });
}

function submitQuestionFlow(flow: QuestionFlow) {
  try {
    const lastAnswer = flow.questions[flow.currentIndex - 1]?.userAnswer || '';
    apiRef.client.question.reply({
       requestID: flow.requestId,
       answers: flow.questions.map(q => [q.userAnswer || ''])
    }).catch(()=>{});
    
    const q = flow.questions[flow.questions.length - 1];
    const num = flow.questions.length > 1 ? ` (${flow.questions.length}/${flow.questions.length})` : '';
    const msg = `✅ *${flow.title}*${num}\n\n${q.question}\n\n_Answered: ${lastAnswer}_`;
    
    if (flow.chatId && flow.messageId) {
        bot?.editMessageText(msg, {
           chat_id: flow.chatId,
           message_id: flow.messageId,
           parse_mode: 'Markdown',
           reply_markup: { inline_keyboard: [] }
        }).catch(() => {});
    }
  } catch(e) {}
  qfMap.delete(flow.requestId);
}

function cancelQuestionFlow(flow: QuestionFlow) {
  try {
    apiRef.client.question.reply({
       requestID: flow.requestId,
       answers: flow.questions.map(() => [''])
    }).catch(()=>{});
    
    const q = flow.questions[flow.currentIndex];
    const num = flow.questions.length > 1 ? ` (${flow.currentIndex + 1}/${flow.questions.length})` : '';
    const msg = `— *${flow.title}*${num}\n\n${q.question}\n\n_Cancelled_`;
    
    if (flow.chatId && flow.messageId) {
        bot?.editMessageText(msg, {
           chat_id: flow.chatId,
           message_id: flow.messageId,
           parse_mode: 'Markdown',
           reply_markup: { inline_keyboard: [] }
        }).catch(() => {});
    }
  } catch(e) {}
  qfMap.delete(flow.requestId);
}

export function stopTelegramBot() {
  if (bot) {
    try {
      bot.stopPolling();
    } catch(e) {}
    setBot(null);
  }
  for (const [msgId, tracking] of activeTails.entries()) {
    tracking.isComplete = true;
    if (tracking.timer) clearInterval(tracking.timer);
  }
  activeTails.clear();
}

let syncLoopRunning = false;

async function syncLoop() {
  if (syncLoopRunning) return;
  syncLoopRunning = true;
  try {
    const now = Date.now();
    let lockData: any = null;
    
    updateActiveProjects();
    
    const state = readState();
    
    const createdData = state.createdSession;
    if (createdData && createdData.timestamp > lastCreatedTimestamp) {
      lastCreatedTimestamp = createdData.timestamp;
    }
    
    const syncData = state.sync;
    if (syncData && syncData.timestamp > lastSyncTimestamp) {
      lastSyncTimestamp = syncData.timestamp;
      if (syncData.targetDir === apiRef.state.path.directory) {
        const sId = syncData.sessionId;
        if (syncData.type === 'navigate') {
          updateCurrentSessionId(sId);
          if (sId === null) {
            apiRef.route.navigate("home");
          } else {
            apiRef.route.navigate("session", { sessionID: sId });
          }
        } else if (syncData.type === 'prompt') {
          if (sId) {
            const requestId = pendingQuestions.get(sId);
            if (requestId) {
              apiRef.client.question.reply({ requestID: requestId, answers: [[syncData.text]] }).catch(()=>{});
              pendingQuestions.delete(sId);
            } else {
              updateCurrentSessionId(sId);
              apiRef.route.navigate("session", { sessionID: sId });

              const promptOpts: any = { sessionID: sId, parts: [{ type: "text", text: syncData.text }] };
              if (syncData.model) {
                promptOpts.model = syncData.model;
              } else if (selectedModel) {
                promptOpts.model = { providerID: selectedModel.providerID, modelID: selectedModel.modelID };
              }
              apiRef.client.session.prompt(promptOpts).catch(()=>{});
            }
          } else {
            apiRef.client.session.create({ directory: apiRef.state.path.directory }).then((createRes: any) => {
              const newSessionId = createRes.data?.id || createRes.id;
              if (newSessionId) {
                updateCurrentSessionId(newSessionId);
                apiRef.route.navigate("session", { sessionID: newSessionId });
                updateState('createdSession', { sessionId: newSessionId, timestamp: Date.now() });
                const promptOpts: any = { sessionID: newSessionId, parts: [{ type: "text", text: syncData.text }] };
                if (syncData.model) {
                  promptOpts.model = syncData.model;
                } else if (selectedModel) {
                  promptOpts.model = { providerID: selectedModel.providerID, modelID: selectedModel.modelID };
                }
                apiRef.client.session.prompt(promptOpts).catch(()=>{});
              }
            }).catch(()=>{});
          }
        } else if (syncData.type === 'model_change') {
          if (sId) {
            apiRef.client.session.switchModel({
              sessionID: sId,
              model: { id: syncData.modelID, providerID: syncData.providerID }
            }).catch(()=>{});
          }
        } else if (syncData.type === 'agent_change') {
          if (sId) {
            apiRef.client.session.switchAgent({
              sessionID: sId,
              agent: syncData.agent
            }).catch(()=>{});
          }
        }
      }
    }
    
    if (isLeader && state.menuUpdateTimestamp && state.menuUpdateTimestamp > lastMenuUpdateTimestamp) {
        lastMenuUpdateTimestamp = state.menuUpdateTimestamp;
        triggerSessionsMenuUpdate();
    }
    
    if (isLeader && state.pendingRecap) {
      const { chatId, messageId, sessionId, timestamp: recapTs } = state.pendingRecap;
      if (recapTs > 0 && (now - recapTs) > 3000) {
        let shouldFire = false;
        try {
          const st = apiRef.state.session.status(sessionId);
          const type = typeof st === "string" ? st : (st?.type || "");
          if (type === "idle" || type === "done" || type === "") {
            shouldFire = true;
          }
        } catch(e) {
          if ((now - recapTs) > 10000) shouldFire = true;
        }
        if (shouldFire) {
          const newState = readState();
          if (newState.pendingRecap?.sessionId === sessionId) {
            delete newState.pendingRecap;
            writeState(newState);
            sendAutoRecap(chatId, messageId, sessionId);
          }
        }
      }
    }
    
    if (fs.existsSync(LOCK_FILE)) {
      try {
        lockData = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
      } catch (e) {}
    }

    if (!lockData || now - lockData.timestamp > 15000) {
      try {
        fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, timestamp: now }));
        if (!isLeader) {
          setIsLeader(true);
          startTelegramBot();
        }
      } catch (e) {}
    } else if (lockData.pid === process.pid) {
      try {
        fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, timestamp: now }));
      } catch (e) {}
    } else {
      if (isLeader) {
        setIsLeader(false);
        stopTelegramBot();
      }
    }
  } catch(e) {
    console.error("[Telegram] syncLoop error:", e);
  } finally {
    syncLoopRunning = false;
  }
}

export function initTelegram(api: any) {
  setApiRef(api);
  const config = loadConfig();
  if (!config) {
    updateState('telegramStatus', 'missing');
    return;
  }
  
  if (!leaderInterval) {
    syncLoop();
    setLeaderInterval(setInterval(syncLoop, 1000));
  }
}

export function notifyTelegram(message: string, inlineOptions?: { text: string, callback_data: string }[]) {
  if (!isLeader || !bot || allowedUsers.length === 0) return;
  const opts: any = {};
  if (inlineOptions && inlineOptions.length > 0) {
    opts.reply_markup = {
      inline_keyboard: [inlineOptions]
    };
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

  const state = readState();
  setAllowedUsers(config.allowedUsers);

  // Initialize selectedModel
  if (state.sync?.model) {
     setSelectedModel(state.sync.model);
  }

  const newBot = new TelegramBot(config.token, { polling: true });
  setBot(newBot);

  newBot.setMyCommands([
    { command: 'projects', description: 'List workspace projects' },
    { command: 'sessions', description: 'List active sessions' },
    { command: 'tail', description: 'Watch live session stream' },
    { command: 'recap', description: 'Generate session summary' },
    { command: 'models', description: 'Switch LLM model' },
    { command: 'help', description: 'Show command list help' }
  ]).catch(() => {});

  newBot.on('callback_query', async (query) => {
    if (!query.from || !allowedUsers.includes(query.from.id)) return;
    if (!query.message || !query.data) return;

    if (query.data.startsWith('nav_')) {
      const isSessionsMsg = lastSessionsMessage && query.message.message_id === lastSessionsMessage.messageId;
      const isHistoryMsg = lastHistoryMessage && query.message.message_id === lastHistoryMessage.messageId;
      if (!isSessionsMsg && !isHistoryMsg) {
        newBot.answerCallbackQuery(query.id, { text: "Menu outdated. Send /sessions or /history again." });
        return;
      }
      const targetId = query.data.replace('nav_', '');
      const sId = targetId === 'home' ? null : targetId;
      const targetDir = activeProjectDir || apiRef.state.path.directory;
      try {
         const state = readState();
         state.sync = { type: 'navigate', targetDir, sessionId: sId, timestamp: Date.now() };
         state.activeSessions = state.activeSessions || {};
         state.activeSessions[targetDir] = sId;
         writeState(state);

         newBot.answerCallbackQuery(query.id, { text: "Session switched." });
         
         try {
           if (isSessionsMsg) {
              const sessKb = await getSessionsKeyboard(false);
              newBot.editMessageReplyMarkup({ inline_keyboard: sessKb }, { chat_id: lastSessionsMessage!.chatId, message_id: lastSessionsMessage!.messageId }).catch(() => {});
           } else if (isHistoryMsg) {
              const sessKb = await getSessionsKeyboard(true);
              newBot.editMessageReplyMarkup({ inline_keyboard: sessKb }, { chat_id: lastHistoryMessage!.chatId, message_id: lastHistoryMessage!.messageId }).catch(() => {});
           }
         } catch(e) {}
      } catch (e) {
        newBot.answerCallbackQuery(query.id, { text: "Failed to navigate" });
      }
    } else if (query.data.startsWith('proj_select_')) {
      if (lastProjectsMessage && query.message.message_id !== lastProjectsMessage.messageId) {
        newBot.answerCallbackQuery(query.id, { text: "Menu outdated. Send /projects again." });
        return;
      }
      const shortId = query.data.replace('proj_select_', '');
      const targetDir = projectIds.get(shortId);
      if (targetDir) {
          setActiveProjectDir(targetDir);
          newBot.answerCallbackQuery(query.id, { text: `Project selected: ${path.basename(targetDir)}` });
          try {
             const kb = await getProjectsKeyboard();
             newBot.editMessageReplyMarkup({ inline_keyboard: kb }, { chat_id: query.message.chat.id, message_id: query.message.message_id }).catch(() => {});
             
             if (lastSessionsMessage && lastSessionsMessage.chatId === query.message.chat.id &&
                 lastProjectsMessage && lastSessionsMessage.timestamp > lastProjectsMessage.timestamp) {
                  const sessKb = await getSessionsKeyboard(false);
                  try {
                    await newBot.editMessageReplyMarkup({ inline_keyboard: sessKb }, { chat_id: lastSessionsMessage.chatId, message_id: lastSessionsMessage.messageId });
                  } catch(e) {
                    newBot.deleteMessage(lastSessionsMessage.chatId, lastSessionsMessage.messageId).catch(()=>{});
                    setLastSessionsMessage(null);
                    await handleSessionsCommand(query.message.chat.id);
                  }
              }
              
              if (lastHistoryMessage && lastHistoryMessage.chatId === query.message.chat.id &&
                  lastProjectsMessage && lastHistoryMessage.timestamp > lastProjectsMessage.timestamp) {
                  const histKb = await getSessionsKeyboard(true);
                  try {
                    await newBot.editMessageReplyMarkup({ inline_keyboard: histKb }, { chat_id: lastHistoryMessage.chatId, message_id: lastHistoryMessage.messageId });
                  } catch(e) {
                    newBot.deleteMessage(lastHistoryMessage.chatId, lastHistoryMessage.messageId).catch(()=>{});
                    setLastHistoryMessage(null);
                    await handleHistoryCommand(query.message.chat.id);
                  }
              }
           } catch(e) {}
      } else {
          newBot.answerCallbackQuery(query.id, { text: "Project not found. Run /projects again." });
      }
    } else if (query.data === 'proj_launch') {
      const currentSelected = activeProjectDir || apiRef?.state?.path?.directory;
      if (!currentSelected || !query.message) {
        newBot.answerCallbackQuery(query.id, { text: "No project selected." });
        return;
      }
      const chatId = query.message.chat.id;
      const messageId = query.message.message_id;
      const dirName = path.basename(currentSelected);
      newBot.answerCallbackQuery(query.id, { text: `Launching OpenCode in ${dirName}...` });

      launchOpenCodeInstance(currentSelected, (err) => {
        if (err) {
          console.error("[Telegram] Failed to launch project CLI:", err);
          newBot.sendMessage(chatId, `❌ Failed to launch OpenCode: ${escapeHtml(err.message)}`).catch(() => {});
        } else {
          let attempts = 0;
          const pollTimer = setInterval(async () => {
            attempts++;
            const state = readState();
            const lastTs = state.projects?.[currentSelected] || 0;
            const isOnline = (Date.now() - lastTs < 8000);
            
            if (isOnline) {
              clearInterval(pollTimer);
              const kb = await getProjectsKeyboard();
              newBot.editMessageReplyMarkup({ inline_keyboard: kb }, { chat_id: chatId, message_id: messageId }).catch(() => {});
            } else if (attempts > 30) {
              clearInterval(pollTimer);
            }
          }, 500);
        }
      });
    } else if (query.data === 'proj_list_sessions') {
      newBot.answerCallbackQuery(query.id, { text: "Listing sessions..." });
      await handleSessionsCommand(query.message.chat.id);
    } else if (query.data === 'sess_tail') {
      const queryDir = activeProjectDir || apiRef.state.path.directory;
      let currentActive: string | null = null;
      try { currentActive = readState().activeSessions?.[queryDir] || null; } catch(e) {}
      if (!currentActive) {
        newBot.answerCallbackQuery(query.id, { text: "No active session selected." });
        return;
      }
      newBot.answerCallbackQuery(query.id, { text: "Starting tailing..." });
      await handleTailCommand(query.message.chat.id, currentActive);
    } else if (query.data === 'sess_recap') {
      const queryDir = activeProjectDir || apiRef.state.path.directory;
      let currentActive: string | null = null;
      try { currentActive = readState().activeSessions?.[queryDir] || null; } catch(e) {}
      if (!currentActive) {
        newBot.answerCallbackQuery(query.id, { text: "No active session selected." });
        return;
      }
      newBot.answerCallbackQuery(query.id, { text: "Generating recap..." });
      await sendAutoRecap(query.message.chat.id, undefined, currentActive);
    } else if (query.data === 'sess_show_question') {
      const queryDir = activeProjectDir || apiRef.state.path.directory;
      let currentActive: string | null = null;
      try { currentActive = readState().activeSessions?.[queryDir] || null; } catch(e) {}
      
      if (!currentActive) {
        newBot.answerCallbackQuery(query.id, { text: "No active session selected." });
        return;
      }
      
      const chatId = query.message.chat.id;
      
      let foundFlow: QuestionFlow | null = null;
      for (const flow of qfMap.values()) {
        if (flow.sessionId === currentActive) {
          foundFlow = flow;
          break;
        }
      }
      
      if (foundFlow) {
        newBot.answerCallbackQuery(query.id, { text: "Resending question..." });
        sendQuestionMessage(foundFlow);
        return;
      }
      
      let foundPermShortId: string | null = null;
      let foundPerm: any = null;
      for (const [shortId, req] of permissionRequests.entries()) {
        if (req.sessionId === currentActive) {
          foundPermShortId = shortId;
          foundPerm = req;
          break;
        }
      }
      
      if (foundPerm && foundPermShortId) {
        newBot.answerCallbackQuery(query.id, { text: "Resending permission request..." });
        
        let desc = "Session needs permission to execute a tool.";
        try {
          if (apiRef?.state?.session?.permission) {
            const p = apiRef.state.session.permission(currentActive);
            if (p && p.length > 0) {
              desc = p[0].description || desc;
            }
          }
        } catch(e) {}
        
        newBot.sendMessage(chatId, `⚠️ **Permission Request**\n\n${escapeHtml(desc)}`, {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [
                { text: "✅ Allow", callback_data: `perm_allow_${foundPermShortId}` },
                { text: "❌ Deny", callback_data: `perm_deny_${foundPermShortId}` }
              ]
            ]
          }
        }).catch(() => {});
        return;
      }
      
      newBot.answerCallbackQuery(query.id, { text: "No active question or permission request found." });
      newBot.sendMessage(chatId, "⚠️ No active question or permission request found for this session.").catch(() => {});
    } else if (query.data.startsWith('stop_tracking_')) {
      const msgId = parseInt(query.data.replace('stop_tracking_', ''), 10);
      
      const tailTracking = activeTails.get(msgId);
      if (tailTracking) {
        tailTracking.isComplete = true;
        if (tailTracking.timer) clearInterval(tailTracking.timer);
        activeTails.delete(msgId);
        
        newBot.answerCallbackQuery(query.id, { text: "Tailing stopped." });
        
        const finalMsg = tailTracking.lastText;
        newBot.editMessageText(finalMsg, {
          chat_id: query.message.chat.id,
          message_id: msgId,
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [] }
        }).catch(() => {});
        return;
      }
      
      let foundSessId: string | null = null;
      for (const [sessId, t] of activeTrackings.entries()) {
        if (t.messageId === msgId) {
          foundSessId = sessId;
          break;
        }
      }
      
      if (foundSessId) {
        const tracking = activeTrackings.get(foundSessId);
        if (tracking) {
          tracking.isComplete = true;
          if (tracking.timer) clearInterval(tracking.timer);
          activeTrackings.delete(foundSessId);
          sessionFinalizers.delete(foundSessId);
          
          newBot.answerCallbackQuery(query.id, { text: "Tracking stopped." });
          
          const finalMsg = tracking.lastText;
          newBot.editMessageText(finalMsg, {
            chat_id: query.message.chat.id,
            message_id: msgId,
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: [] }
          }).catch(() => {});
          return;
        }
      }
      
      newBot.answerCallbackQuery(query.id, { text: "Tracking already stopped or expired." });
      newBot.editMessageReplyMarkup({ inline_keyboard: [] }, {
        chat_id: query.message.chat.id,
        message_id: query.message.message_id
      }).catch(() => {});
    } else if (query.data.startsWith('perm_allow_') || query.data.startsWith('perm_deny_')) {
      const isAllow = query.data.startsWith('perm_allow_');
      const shortId = query.data.replace(isAllow ? 'perm_allow_' : 'perm_deny_', '');
      const req = permissionRequests.get(shortId);
      
      if (!req) {
         newBot.answerCallbackQuery(query.id, { text: "Permission request expired or invalid." });
         return;
      }
      
      try {
        await apiRef.client.permission.reply({
           requestID: req.permId,
           reply: isAllow ? "once" : "reject"
        });
        newBot.answerCallbackQuery(query.id, { text: isAllow ? "✅" : "❌" });
        permissionRequests.delete(shortId);
        
        newBot.editMessageText(query.message.text + `\n\n_Decision: ${isAllow ? "Allowed ✅" : "Denied ❌"}_`, {
           chat_id: query.message.chat.id,
           message_id: query.message.message_id,
           reply_markup: { inline_keyboard: [] }
        }).catch(() => {});
      } catch(e) {
         newBot.answerCallbackQuery(query.id, { text: "Error replying to permission request." });
      }
    } else if (query.data.startsWith('q_ans_') || query.data === 'q_cancel') {
       let foundFlow: QuestionFlow | null = null;
       for (const flow of qfMap.values()) {
         if (flow.messageId === query.message.message_id) {
           foundFlow = flow;
           break;
         }
       }
       if (!foundFlow) {
         newBot.answerCallbackQuery(query.id, { text: "Question expired." });
         return;
       }
       
       if (query.data === 'q_cancel') {
         newBot.answerCallbackQuery(query.id, { text: "Question cancelled." });
         cancelQuestionFlow(foundFlow);
         return;
       }
       
       const ans = query.data.replace('q_ans_', '');
       newBot.answerCallbackQuery(query.id, { text: `Answer: ${ans}` });
       
       const q = foundFlow.questions[foundFlow.currentIndex];
       q.userAnswer = ans;
       
       foundFlow.currentIndex++;
       if (foundFlow.currentIndex < foundFlow.questions.length) {
         sendQuestionMessage(foundFlow);
       } else {
         submitQuestionFlow(foundFlow);
       }
    } else if (query.data.startsWith('model_select_')) {
      const shortId = query.data.replace('model_select_', '');
      const modelID = modelIds.get(shortId);
      if (modelID) {
         let providerID = 'openrouter';
         if (modelID.includes('gemini/')) providerID = 'gemini';
         else if (modelID.includes('anthropic/')) providerID = 'anthropic';
         else if (modelID.includes('vertex/')) providerID = 'vertex';
         else if (modelID.includes('openai/')) providerID = 'openai';
         
         const cleanModelId = modelID.replace(/^(openrouter|gemini|anthropic|vertex|openai)\//, '');
         
         const targetDir = activeProjectDir || apiRef.state.path.directory;
         const state = readState();
         const currentActive = state.activeSessions?.[targetDir] || null;
         
         if (currentActive) {
           try {
             state.sync = {
               type: 'model_change',
               targetDir,
               sessionId: currentActive,
               providerID,
               modelID: cleanModelId,
               timestamp: Date.now()
             };
             writeState(state);
             saveSessionModel(currentActive, providerID, cleanModelId);
           } catch(e) {}
         }
         
         try {
            if (query.message) {
               const kb = await getModelsKeyboard();
               newBot.editMessageReplyMarkup({ inline_keyboard: kb }, { chat_id: query.message.chat.id, message_id: query.message.message_id }).catch(() => {});
            }
         } catch(e) {}
         
         newBot.answerCallbackQuery(query.id, { text: `✅ Model: ${cleanModelId}` });
      }
    }
  });

  newBot.on('message', async (msg) => {
    if (!msg.from || !allowedUsers.includes(msg.from.id)) return;
    if (!msg.text) return;

    const text = msg.text.trim();

    // Check if this is a reply to a known session message
    let replySessionId: string | null = null;
    let replyDir: string | null = null;
    if (msg.reply_to_message) {
      try {
        const state = readState();
        const mapped = state.messageSessions?.[msg.reply_to_message.message_id];
        if (mapped) {
          replySessionId = mapped.sessionId;
          replyDir = mapped.directory;
        }
      } catch(e) {}
    }

    if (text.startsWith('/')) {
      const parts = text.split(' ');
      const cmd = parts[0].toLowerCase();
      
      if (cmd === '/start') {
        await handleStart(msg.chat.id);
      } else if (cmd === '/projects') {
        await handleProjectsCommand(msg.chat.id);
      } else if (cmd === '/sessions') {
        await handleSessionsCommand(msg.chat.id);
      } else if (cmd === '/models') {
        await handleModelsCommand(msg.chat.id);
      } else if (cmd === '/recap') {
        await handleRecapCommand(msg.chat.id);
      } else if (cmd === '/history') {
        await handleHistoryCommand(msg.chat.id);
      } else if (cmd === '/tail') {
        const sessIdArg = parts.length > 1 ? parts[1] : null;
        await handleTailCommand(msg.chat.id, sessIdArg);
      } else if (cmd === '/help') {
        await handleHelpCommand(msg.chat.id);
      }
      return;
    }

    // Treat as prompt input
    await handleIncomingText(msg.chat.id, text, replySessionId, replyDir);
  });
}

async function handleModelsCommand(chatId: number) {
  try {
    const kb = await getModelsKeyboard();
    bot?.sendMessage(chatId, "🤖 <b>Models</b>", {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: kb }
    });
  } catch (err) {
    bot?.sendMessage(chatId, "❌ Failed to list models.").catch(() => {});
  }
}

async function getModelsKeyboard() {
  const kb: any[][] = [];
  try {
    const modelsRes = await apiRef.client.model.list({});
    let models = modelsRes.data || modelsRes || [];
    if (!Array.isArray(models)) models = [];
    
    const favs = ['openrouter/anthropic/claude-3.5-sonnet', 'gemini/gemini-2.5-pro', 'openrouter/google/gemini-2.5-pro'];
    const recents: string[] = [];
    
    models.sort((a: any, b: any) => {
      const priA = getModelPriority(a.providerID, a.id, favs, recents);
      const priB = getModelPriority(b.providerID, b.id, favs, recents);
      if (priA !== priB) return priB - priA;
      return a.id.localeCompare(b.id);
    });

    const targetDir = activeProjectDir || apiRef.state.path.directory;
    const currentActive = readState().activeSessions?.[targetDir] || null;
    let currentModelID = '';
    let currentProviderID = '';
    if (currentActive) {
      const mData = readState().sessionModels?.[currentActive];
      if (mData) {
        currentModelID = mData.modelID;
        currentProviderID = mData.providerID;
      }
    }

    models.slice(0, 10).forEach((m: any) => {
      const isSelected = m.id === currentModelID && m.providerID === currentProviderID;
      const title = modelName(m);
      const cleanId = `${m.providerID}/${m.id}`;
      
      let hash = 5381;
      for (let i = 0; i < cleanId.length; i++) {
        hash = ((hash << 5) + hash) + cleanId.charCodeAt(i);
      }
      const shortId = Math.abs(hash).toString(16);
      
      modelIds.set(shortId, cleanId);
      kb.push([{ text: `${isSelected ? '→ ' : ''}${title}`, callback_data: `model_select_${shortId}` }]);
    });
  } catch(e) {}
  return kb;
}

function modelName(m: any): string {
  const p = m.providerID || '';
  const id = m.modelID || m.id || '';
  if (p === 'openrouter') return id.split('/').pop() || id;
  return id;
}

function getModelPriority(providerID: string, modelID: string, favorites: string[], recents: string[]): number {
  const modelStr = `${providerID}/${modelID}`;
  if (favorites.includes(modelStr)) return 100 - favorites.indexOf(modelStr);
  if (recents.includes(modelStr)) return 50 - recents.indexOf(modelStr);
  if (providerID === 'anthropic' && modelID.includes('claude-3-5-sonnet')) return 10;
  if (providerID === 'gemini' && modelID.includes('gemini-2.5-pro')) return 9;
  if (providerID === 'gemini' && modelID.includes('gemini-2.5-flash')) return 8;
  return 0;
}

async function handleRecapCommand(chatId: number) {
  const targetDir = activeProjectDir || apiRef.state.path.directory;
  let currentActive: string | null = null;
  try { currentActive = readState().activeSessions?.[targetDir] || null; } catch(e) {}
  
  if (!currentActive) {
    bot?.sendMessage(chatId, "⚠️ No active session to recap. Start a session or use /sessions to select one.");
    return;
  }
  
  const status = getSessionStatus(currentActive);
  if (status !== 'idle' && status !== 'done' && status !== '') {
    bot?.sendMessage(chatId, `⏳ Recap will be sent automatically as soon as the session stops running...`);
    updateState('pendingRecap', { chatId, sessionId: currentActive, timestamp: Date.now() });
    return;
  }
  
  await sendAutoRecap(chatId, undefined, currentActive);
}

async function handleIncomingText(chatId: number, text: string, replySessionId: string | null, replyDir: string | null) {
  const targetDir = replyDir || activeProjectDir || apiRef.state.path.directory;
  let currentActive: string | null = null;
  if (replySessionId) {
    currentActive = replySessionId;
  } else {
    try { currentActive = readState().activeSessions?.[targetDir] || null; } catch(e) {}
  }
  
  if (currentActive) {
    const qId = pendingQuestions.get(currentActive);
    if (qId) {
      let foundFlow: QuestionFlow | null = null;
      for (const flow of qfMap.values()) {
        if (flow.requestId === qId) {
          foundFlow = flow;
          break;
        }
      }
      
      if (foundFlow) {
         const q = foundFlow.questions[foundFlow.currentIndex];
         q.userAnswer = text;
         foundFlow.currentIndex++;
         if (foundFlow.currentIndex < foundFlow.questions.length) {
           sendQuestionMessage(foundFlow);
         } else {
           submitQuestionFlow(foundFlow);
         }
         return;
      }
    }
  }

  // Generate tracking message and start tracking
  const sentMsg = await bot?.sendMessage(chatId, "⏳ Sending prompt to session...", {
    reply_markup: {
      inline_keyboard: [[{ text: '❌ Stop Tracking', callback_data: `stop_tracking_${Date.now()}` }]]
    }
  });
  if (!sentMsg) return;

  const trackingMsgId = sentMsg.message_id;

  if (!currentActive) {
    try {
      apiRef.client.session.create({ directory: targetDir }).then(async (createRes: any) => {
        const newSessionId = createRes.data?.id || createRes.id;
        if (newSessionId) {
          updateCurrentSessionId(newSessionId);
          
          const state = readState();
          state.activeSessions = state.activeSessions || {};
          state.activeSessions[targetDir] = newSessionId;
          writeState(state);

          registerMessageSession(trackingMsgId, newSessionId, targetDir);

          const promptOpts: any = { sessionID: newSessionId, parts: [{ type: "text", text }] };
          if (selectedModel) {
            promptOpts.model = { providerID: selectedModel.providerID, modelID: selectedModel.modelID };
          }
          apiRef.client.session.prompt(promptOpts).catch(()=>{});

          startPollingPrompt(newSessionId, chatId, trackingMsgId, targetDir, Date.now());
        }
      }).catch((e: any) => {
        bot?.sendMessage(chatId, `❌ Failed to create session: ${escapeHtml(e.message)}`).catch(() => {});
      });
    } catch(e) {}
    return;
  }

  registerMessageSession(trackingMsgId, currentActive, targetDir);

  const promptOpts: any = { sessionID: currentActive, parts: [{ type: "text", text }] };
  if (selectedModel) {
    promptOpts.model = { providerID: selectedModel.providerID, modelID: selectedModel.modelID };
  }

  const isLocal = targetDir === apiRef.state.path.directory;
  if (isLocal) {
    apiRef.client.session.prompt(promptOpts).catch(()=>{});
  } else {
    updateState('sync', {
      type: 'prompt',
      targetDir,
      sessionId: currentActive,
      text,
      model: selectedModel ? { providerID: selectedModel.providerID, modelID: selectedModel.modelID } : undefined,
      timestamp: Date.now()
    });
  }

  startPollingPrompt(currentActive, chatId, trackingMsgId, targetDir, Date.now());
}

import TelegramBot from 'node-telegram-bot-api';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { exec } from 'child_process';
import util from 'util';

const execAsync = util.promisify(exec);

let bot: TelegramBot | null = (globalThis as any).__sessionTrackerBot || null;
let apiRef: any = null;
let currentSessionId: string | null = null;
let allowedUsers: number[] = [];
let selectedModel: any = null;
let activeProjectDir: string | null = null;
let isLeader = false;
let leaderInterval: any = null;
let lastSessionsMessage: { chatId: number, messageId: number, timestamp: number } | null = null;
let lastProjectsMessage: { chatId: number, messageId: number, timestamp: number } | null = null;

// Active SSE subscriptions keyed by sessionId.
// Each entry has an abort function and the tracking message info.
interface ActiveTracking {
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
const activeTrackings = new Map<string, ActiveTracking>();
// Stores finalize functions keyed by sessionId so external callers (e.g. notifySessionIdle) can trigger them
const sessionFinalizers = new Map<string, () => void>();

const STATE_DIR = path.join(os.homedir(), '.cache', 'opencode-session-tracker');
try {
  if (!fs.existsSync(STATE_DIR)) {
    fs.mkdirSync(STATE_DIR, { recursive: true });
  }
} catch(e) {}

const LOCK_FILE = path.join(STATE_DIR, 'session-tracker.lock');
const STATE_FILE = path.join(STATE_DIR, 'session-tracker.json');

export function logDebug(msg: string) {
  // Disabled in production
}

function readState(): any {
  if (!fs.existsSync(STATE_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch(e) { return {}; }
}

function writeState(data: any) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(data)); } catch(e) {}
}

function updateState(key: string, value: any) {
  const state = readState();
  state[key] = value;
  writeState(state);
}

function formatThinkingText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return '';

  // Split into sentences/lines (boundaries like .?! followed by space, or newline)
  const parts = trimmed.split(/(?<=[.?!])\s+|\n+/);
  const cleanParts = parts.map(p => p.trim()).filter(Boolean);

  if (cleanParts.length <= 2) {
    if (trimmed.length > 250) {
      return trimmed.slice(0, 120) + ' ... ' + trimmed.slice(-120);
    }
    return trimmed;
  }

  const first = cleanParts[0];
  const last = cleanParts[cleanParts.length - 1];

  const maxPartLen = 150;
  const safeFirst = first.length > maxPartLen ? first.slice(0, maxPartLen) + '...' : first;
  const safeLast = last.length > maxPartLen ? last.slice(-maxPartLen) : last;

  return `${safeFirst}\n...\n${safeLast}`;
}

const permissionRequests = new Map<string, { sessionId: string, permId: string }>();
const pendingQuestions = new Map<string, string>();
const projectIds = new Map<string, string>();

function buildFooter(sData: any): string {
  if (!sData) return '';
  let footer = '';
  try {
    const add = sData.summary_additions ?? sData.summary?.additions ?? 0;
    const del = sData.summary_deletions ?? sData.summary?.deletions ?? 0;
    const files = sData.summary_files ?? sData.summary?.files ?? 0;
    if (add > 0 || del > 0 || files > 0) footer = `\n+${add} / -${del} across ${files} file(s)`;
    const parts: string[] = [];
    if (sData.agent) {
      const aName = sData.agent.split('-')[0].trim();
      parts.push(aName);
    }
    const mName = modelName(sData.model);
    if (mName) parts.push(mName);
    const created = typeof sData.time_created === 'number' ? sData.time_created : sData.time?.created || 0;
    const updated = typeof sData.time_updated === 'number' ? sData.time_updated : sData.time?.updated || 0;
    if (created > 0 && updated > 0) {
      const sec = Math.round((updated - created) / 1000);
      parts.push(sec < 60 ? `${sec}s` : `${Math.floor(sec/60)}m ${sec%60}s`);
    }
    const totalTokens = (sData.tokens_input ?? sData.tokensInput ?? 0) + (sData.tokens_output ?? sData.tokensOutput ?? 0) + (sData.tokens_reasoning ?? sData.tokensReasoning ?? 0);
    parts.push(`${(totalTokens / 1000).toFixed(1)}K`);
    parts.push(`$${(sData.cost ?? 0).toFixed(2)}`);
    if (parts.length > 0) footer += `\n\n_${parts.join(' · ')}_`;
  } catch(e) {}
  return footer;
}

function modelName(m: any): string {
  if (!m) return '';
  if (typeof m === 'object') return m.modelID || m.id || '';
  try { const p = JSON.parse(m); return p.modelID || p.id || ''; } catch(e) {}
  if (typeof m === 'string' && m.includes('/')) return m.split('/').pop() || m;
  return '';
}

let lastSyncTimestamp = 0;
let lastCreatedTimestamp = 0;
let lastMenuUpdateTimestamp = 0;
let lastModelsMessage: { chatId: number, messageId: number, timestamp: number } | null = null;

const modelIds = new Map<string, { providerID: string, modelID: string }>();
let modelMsgCounter = 0;

const MODEL_STATE_PATH = path.join(os.homedir(), '.local', 'state', 'opencode', 'model.json');

function getModelPriority(providerID: string, modelID: string, favorites: string[], recents: string[]): number {
  const key = `${providerID}/${modelID}`;
  const favIdx = favorites.indexOf(key);
  if (favIdx >= 0) return favIdx;
  const recIdx = recents.indexOf(key);
  if (recIdx >= 0) return 1000 + recIdx;
  return 999999;
}

async function getModelsKeyboard() {
  const res = await apiRef.client.config.providers();
  const providers = res.data?.providers || res.providers || [];
  const allModels: { pId: string, mId: string, name: string }[] = [];
  
  for (const p of providers) {
    if (!p.models) continue;
    for (const modelId in p.models) {
      allModels.push({ pId: p.id, mId: modelId, name: p.models[modelId].name || modelId });
    }
  }
  
  // Read favorite and recent models from OpenCode state file
  let favorites: string[] = [];
  let recents: string[] = [];
  try {
    if (fs.existsSync(MODEL_STATE_PATH)) {
      const state = JSON.parse(fs.readFileSync(MODEL_STATE_PATH, 'utf8'));
      if (state.favorite) favorites = state.favorite.map((m: any) => `${m.providerID}/${m.modelID}`);
      if (state.recent) recents = state.recent.map((m: any) => `${m.providerID}/${m.modelID}`);
    }
  } catch(e) {}
  
  // Sort: favorites first (in order), then recents, then rest
  allModels.sort((a, b) => {
    const pa = getModelPriority(a.pId, a.mId, favorites, recents);
    const pb = getModelPriority(b.pId, b.mId, favorites, recents);
    if (pa !== pb) return pa - pb;
    return a.name.localeCompare(b.name);
  });
  
  let currentModelId: string | null = null;
  let currentProviderId: string | null = null;
  
  const targetDir = activeProjectDir || apiRef.state.path.directory;
  let currentActive = null;
  try { currentActive = readState().activeSessions?.[targetDir] || null; } catch(e) {}
  
  if (currentActive) {
    try {
      const state = readState();
      const sModel = state.sessionModels?.[currentActive];
      if (sModel) {
        currentProviderId = sModel.providerID;
        currentModelId = sModel.modelID;
      }
    } catch(e) {}
  }
  
  if (!currentModelId) {
    try {
      const configRes = await apiRef.client.config.get({ directory: apiRef.state.path.directory });
      const cfg = configRes?.data || configRes;
      if (cfg?.model && typeof cfg.model === 'string' && cfg.model.includes('/')) {
        const parts = cfg.model.split('/');
        currentProviderId = parts[0];
        currentModelId = parts.slice(1).join('/');
      }
    } catch(e) {}
  }
  if (!currentModelId && selectedModel) {
    currentProviderId = selectedModel.providerID;
    currentModelId = selectedModel.modelID;
  }
  
  const inlineKeyboard: any[][] = [];
  const limitedModels = allModels.slice(0, 15);
  
  for (const m of limitedModels) {
    const isCurrent = currentProviderId === m.pId && currentModelId === m.mId;
    const btnText = isCurrent ? `→ ${m.name}` : m.name;
    const shortId = `m${++modelMsgCounter}`;
    modelIds.set(shortId, { providerID: m.pId, modelID: m.mId });
    inlineKeyboard.push([{ text: btnText, callback_data: `model_select_${shortId}` }]);
  }
  
  return inlineKeyboard;
}


export function saveSessionStatus(sessionId: string, status: string) {
  try {
    const state = readState();
    const statuses = state.statuses || {};
    statuses[sessionId] = status;
    state.statuses = statuses;
    writeState(state);
    
    updateState('menuUpdateTimestamp', Date.now());
  } catch(e) {}
}

export function saveSessionModel(sessionId: string, providerID: string, modelID: string) {
  try {
    const state = readState();
    const sessionModels = state.sessionModels || {};
    sessionModels[sessionId] = { providerID, modelID };
    state.sessionModels = sessionModels;
    writeState(state);
    
    updateState('menuUpdateTimestamp', Date.now());
  } catch(e) {}
}

export function getPromptStatusPath(sessionId: string): string {
  return path.join(STATE_DIR, `prompt-status-${sessionId}.json`);
}

export function savePromptStatus(sessionId: string, status: string) {
  try {
    const file = getPromptStatusPath(sessionId);
    let data: any = {};
    if (fs.existsSync(file)) {
      try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch(e) {}
    }
    data.status = status;
    data.timestamp = Date.now();
    fs.writeFileSync(file, JSON.stringify(data), 'utf8');
  } catch(e) {}
}

export function savePromptResponse(sessionId: string, text: string, info?: { title?: string; agent?: string; model?: string; duration?: number; tokens?: number; cost?: number }) {
  try {
    const file = getPromptStatusPath(sessionId);
    let data: any = {};
    if (fs.existsSync(file)) {
      try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch(e) {}
    }
    data.text = text;
    data.info = info || data.info || {};
    data.timestamp = Date.now();
    data.isComplete = true;
    fs.writeFileSync(file, JSON.stringify(data), 'utf8');
  } catch(e) {}
}

export function updatePromptResponseMeta(sessionId: string, cost?: number, tokens?: number) {
  try {
    const file = getPromptStatusPath(sessionId);
    if (!fs.existsSync(file)) return;
    let data: any = {};
    try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch(e) {}
    if (!data.info) data.info = {};
    if (cost && cost > 0) data.info.cost = cost;
    if (tokens && tokens > 0) data.info.tokens = tokens;
    fs.writeFileSync(file, JSON.stringify(data), 'utf8');
  } catch(e) {}
}

export function saveSessionAgent(sessionId: string, agent: string) {
  try {
    const state = readState();
    const sessionAgents = state.sessionAgents || {};
    sessionAgents[sessionId] = agent;
    state.sessionAgents = sessionAgents;
    writeState(state);
    updateState('menuUpdateTimestamp', Date.now());
  } catch(e) {}
}

function getSessionStatus(sessionId: string): string {
  try {
    if (apiRef?.state?.session?.question) {
      const q = apiRef.state.session.question(sessionId);
      if (q && q.length > 0) return "ask";
    }
    if (apiRef?.state?.session?.permission) {
      const p = apiRef.state.session.permission(sessionId);
      if (p && p.length > 0) return "perm";
    }
    if (apiRef?.state?.session?.status) {
      const st = apiRef.state.session.status(sessionId);
      if (st) {
          const localStatus = typeof st === "string" ? st : (st.type || "idle");
          if (localStatus !== "idle") return localStatus;
      }
    }
  } catch(e) {}
  
  try {
      const state = readState();
      if (state.statuses && state.statuses[sessionId]) {
          return state.statuses[sessionId];
      }
  } catch(e) {}
  
  return "idle";
}

function statusIcon(status: string): string {
  switch(status) {
    case "busy": case "running": return "🟢";
    case "retry": case "waiting": return "🟡";
    case "ask": case "perm": return "🟣";
    case "error": return "🔴";
    default: return "⚪";
  }
}

export function registerQuestionRequest(sessionId: string, requestId: string) {
    pendingQuestions.set(sessionId, requestId);
}

// Interactive question flow system
interface QuestionFlow {
  id: string;
  requestId: string;
  sessionId: string;
  questions: any[];
  currentIndex: number;
  answers: string[][];
  chatId: number;
  messageId: number | null;
  title: string;
  textMode: boolean;
}

let qfCounter = 0;
const qfMap = new Map<string, QuestionFlow>();

export function notifyTelegramQuestion(requestId: string, sessionId: string, questions: any[], title: string) {
  if (!isLeader || !bot || allowedUsers.length === 0) {
    const q = questions[0];
    let msg = `⚠️ **Question Asked**\nSeans \`${title}\` needs your input!\n\n**${q.question}**`;
    if (q.options?.length > 0) {
        msg += `\n\nOptions:\n` + q.options.map((opt: any) => `- ${opt.label}`).join('\n');
    }
    msg += `\n\n*(Type your answer directly as a message)*`;
    notifyTelegram(msg);
    return;
  }
  
  const qfId = `qf${++qfCounter}`;
  const flow: QuestionFlow = {
    id: qfId,
    requestId,
    sessionId,
    questions,
    currentIndex: 0,
    answers: [],
    chatId: allowedUsers[0],
    messageId: null,
    title,
    textMode: false
  };
  qfMap.set(qfId, flow);
  sendQuestionMessage(flow);
}

function sendQuestionMessage(flow: QuestionFlow) {
  const q = flow.questions[flow.currentIndex];
  const buttons: any[][] = [];
  
  if (q.options && q.options.length > 0) {
    q.options.forEach((opt: any, i: number) => {
      const btnText = opt.description || opt.detail
        ? `${opt.label} — ${(opt.description || opt.detail).slice(0, 50)}`
        : opt.label;
      buttons.push([{ text: btnText, callback_data: `qa_${flow.id}_${i}` }]);
    });
    buttons.push([{ text: "✏️ Type your answer", callback_data: `qtext_${flow.id}` }]);
  }
  buttons.push([{ text: "Cancel", callback_data: `qc_${flow.id}` }]);
  
  const num = flow.questions.length > 1 ? ` *(${flow.currentIndex + 1}/${flow.questions.length})*` : '';
  const msg = `📌 *${flow.title}*${num}\n\n${q.question}`;
  
  const opts: any = {
    parse_mode: 'Markdown'
  };
  if (q.options && q.options.length > 0) {
    opts.reply_markup = { inline_keyboard: buttons };
  }
  
  if (flow.messageId) {
    bot?.editMessageText(msg, { ...opts, chat_id: flow.chatId, message_id: flow.messageId }).catch(() => {});
  } else {
    bot?.sendMessage(flow.chatId, msg, opts).then(sent => {
      flow.messageId = sent.message_id;
    });
  }
}

function submitQuestionFlow(flow: QuestionFlow) {
  const lastAnswer = flow.answers[flow.answers.length - 1]?.[0] || '';
  
  try {
    apiRef.client.question.reply({
      requestID: flow.requestId,
      answers: flow.answers
    }).catch(() => {});
  } catch(e) {}
  
  const q = flow.questions[flow.questions.length - 1];
  const num = flow.questions.length > 1 ? ` (${flow.questions.length}/${flow.questions.length})` : '';
  const msg = `✅ *${flow.title}*${num}\n\n${q.question}\n\n_Answered: ${lastAnswer}_`;
  bot?.editMessageText(msg, {
    chat_id: flow.chatId,
    message_id: flow.messageId!,
    parse_mode: 'Markdown'
  }).catch(() => {});
  
  saveSessionStatus(flow.sessionId, "idle");
  qfMap.delete(flow.id);
}

function cancelQuestionFlow(flow: QuestionFlow) {
  try {
    apiRef.client.question.reply({
      requestID: flow.requestId,
      answers: []
    }).catch(() => {});
  } catch(e) {}
  
  const q = flow.questions[flow.currentIndex];
  const num = flow.questions.length > 1 ? ` (${flow.currentIndex + 1}/${flow.questions.length})` : '';
  const msg = `— *${flow.title}*${num}\n\n${q.question}\n\n_Cancelled_`;
  bot?.editMessageText(msg, {
    chat_id: flow.chatId,
    message_id: flow.messageId!,
    parse_mode: 'Markdown'
  }).catch(() => {});
  
  saveSessionStatus(flow.sessionId, "idle");
  qfMap.delete(flow.id);
}

export async function triggerSessionsMenuUpdate(chatId?: number) {
    if (!lastSessionsMessage) {
       const state = readState();
       if (state.lastSessionsMessage) {
           lastSessionsMessage = state.lastSessionsMessage;
       } else {
           return;
       }
    }
    
    // If we are not the leader, tell the leader to update the menu via IPC
    if (!isLeader) {
        updateState('menuUpdateTimestamp', Date.now());
        return;
    }
    
    const targetChatId = chatId || lastSessionsMessage!.chatId;
    try {
        const sessKb = await getSessionsKeyboard();
        bot?.editMessageReplyMarkup({ inline_keyboard: sessKb }, { chat_id: targetChatId, message_id: lastSessionsMessage!.messageId }).catch(() => {});
    } catch(e) {}
}

export function registerPermissionRequest(sessionId: string, permId: string): string {
    const shortId = Math.random().toString(36).substring(2, 10);
    permissionRequests.set(shortId, { sessionId, permId });
    return shortId;
}

export function updateCurrentSessionId(id: string | null) {
  if (currentSessionId === id) return;
  currentSessionId = id;
  const dir = apiRef?.state?.path?.directory;
  if (dir) {
      try {
          const state = readState();
          const activeSessions = state.activeSessions || {};
          if (activeSessions[dir] !== id) {
             activeSessions[dir] = id;
             state.activeSessions = activeSessions;
             writeState(state);
             triggerSessionsMenuUpdate().catch(()=>{});
          }
      } catch(e) {}
  }
}

function loadConfig() {
  const configPath = path.join(os.homedir(), '.config', 'opencode', 'telegram.json');
  if (fs.existsSync(configPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (data.token && Array.isArray(data.allowedUsers)) {
        return data;
      }
    } catch (err) {
      console.error("[Telegram] Error reading config", err);
    }
  }
  return null;
}

function updateActiveProjects() {
  const dir = apiRef?.state?.path?.directory;
  if (!dir) return;
  const now = Date.now();
  const state = readState();
  const projects = state.projects || {};
  
  projects[dir] = now;
  
  for (const k of Object.keys(projects)) {
    if (now - projects[k] > 86400000) {
      delete projects[k];
    }
  }
  
  state.projects = projects;
  writeState(state);
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
            
            const dir = apiRef.state.path.directory;
            // The Telegram leader will subscribe to SSE events directly
            // (subscribeToSessionEvents is called from handleIncomingText).
            // This path is the TUI-side fallback for cross-process navigation.
            apiRef.client.event.subscribe({ directory: dir }, {
              onSseEvent: (evt: any) => {
                try {
                  const data = evt?.data;
                  if (!data || data.properties?.sessionID !== sId) return;
                  if (data.type === 'session.next.tool.called' && data.properties?.name) {
                    const name = data.properties.name;
                    const input = (data.properties.input || '').slice(0, 40);
                    savePromptStatus(sId, name === 'bash' || name === 'execute_command' ? `⚡ bash: ${input}` : `⚡ ${name}`);
                  } else if (data.type === 'session.next.text.started') {
                    savePromptStatus(sId, '🤔 Thinking...');
                  } else if (data.type === 'session.next.text.ended') {
                    savePromptStatus(sId, '');
                  }
                } catch(e) {}
              }
            }).catch(() => {});
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
  
  // Prompt tracking: poll promptStatuses (written by index.tsx api.event.on handlers)
  // and promptResponses. Both are written by the TUI plugin's event system which
  // receives events for ALL sessions regardless of who sent the prompt.
  if (isLeader && state.pendingPrompt) {
    const { chatId, trackingMessageId, sessionId, lastStatus, timestamp: promptTs } = state.pendingPrompt;
    if (!activeTrackings.has(sessionId) && trackingMessageId && (now - (promptTs || 0)) > 1000 && sessionId) {
      let shouldClear = false;
      let statusText = lastStatus || '⏳ Processing...';

      // Read live status written by index.tsx api.event.on handlers
      let evtStatus = '';
      let resp: any = null;
      const statusFile = getPromptStatusPath(sessionId);
      if (fs.existsSync(statusFile)) {
        try {
          const data = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
          if (data.isComplete) {
            resp = data;
          } else {
            evtStatus = data.status;
          }
        } catch(e) {}
      }

      if (evtStatus) statusText = evtStatus;

      // Check for complete response written by index.tsx session.next.text.ended handler
      if (resp?.text && resp.timestamp > (promptTs || 0)) {
        const d = resp.text.length > 3000 ? resp.text.slice(0, 3000) + '\n\n_...truncated_' : resp.text;
        const h = resp.info?.title ? `📌 *${resp.info.title}*\n\n` : '';
        const parts: string[] = [];
        if (resp.info?.agent) parts.push(resp.info.agent);
        if (resp.info?.model) parts.push(resp.info.model);
        if (resp.info?.duration > 0) parts.push(resp.info.duration < 60 ? `${resp.info.duration}s` : `${Math.floor(resp.info.duration/60)}m ${resp.info.duration%60}s`);
        if (resp.info?.tokens > 0) parts.push(`${(resp.info.tokens/1000).toFixed(1)}K`);
        if (resp.info?.cost > 0) parts.push(`$${resp.info.cost.toFixed(2)}`);
        const f = parts.length > 0 ? `\n\n_${parts.join(' · ')}_` : '';
        statusText = `${h}${d}${f}`;
        shouldClear = true;
        try { fs.unlinkSync(statusFile); } catch(e) {}
      }

      // Final fallback: poll session.messages() if no response after 5s
      if (!shouldClear && (now - (promptTs || 0)) > 5000) {
        try {
          const msgsRes = await apiRef.client.session.messages({ sessionID: sessionId, limit: 5 });
          const msgs = (msgsRes?.data || msgsRes || []) as any[];
          const lastAssistant = [...msgs].reverse().find((m: any) => {
            const role = (m.info || m).role;
            if (role !== 'assistant') return false;
            const msgTime = (m.info || m).time?.created || m.time_created || 0;
            if (msgTime > 0 && msgTime < (promptTs || 0)) return false;
            const t = (m.parts || []).filter((p: any) => p.type === 'text').map((p: any) => p.text || '').join('').trim();
            return t.length > 0;
          });
          if (lastAssistant) {
            const info = lastAssistant.info || lastAssistant;
            const text = (lastAssistant.parts || []).filter((p: any) => p.type === 'text').map((p: any) => p.text || '').join('\n').trim();
            if (text) {
              const d = text.length > 3000 ? text.slice(0, 3000) + '\n\n_...truncated_' : text;
              const parts: string[] = [];
              if (info?.agent) parts.push((info.agent).split('-')[0].trim());
              if (info?.model?.modelID || info?.modelID) parts.push(info?.model?.modelID || info?.modelID);
              const ct = info?.time?.created || info?.time_created || 0;
              if (ct > 0) { const sec = Math.round((now - ct) / 1000); parts.push(sec < 60 ? `${sec}s` : `${Math.floor(sec/60)}m ${sec%60}s`); }
              const tok = (info?.tokens_input || info?.tokensInput || 0) + (info?.tokens_output || info?.tokensOutput || 0);
              if (tok > 0) parts.push(`${(tok/1000).toFixed(1)}K`);
              if (info?.cost > 0) parts.push(`$${info.cost.toFixed(2)}`);
              const f = parts.length > 0 ? `\n\n_${parts.join(' · ')}_` : '';
              let h = '';
              try { const sD = (await apiRef.client.session.get({ sessionID: sessionId }))?.data || {}; if (sD.title) h = `📌 *${sD.title}*\n\n`; } catch(e) {}
              statusText = `${h}${d}${f}`;
              shouldClear = true;
            }
          }
        } catch(e) {}
      }

      if (statusText !== lastStatus || shouldClear) {
        const ns = readState();
        if (ns.pendingPrompt?.sessionId === sessionId) {
          ns.pendingPrompt.lastStatus = statusText;
          if (shouldClear) delete ns.pendingPrompt;
          writeState(ns);
          bot?.editMessageText(statusText, { chat_id: chatId, message_id: trackingMessageId, parse_mode: 'Markdown' }).catch((err: any) => {
            const errMsg = err?.message || String(err);
            if (errMsg.includes("message is not modified")) return;
            bot?.editMessageText(statusText, { chat_id: chatId, message_id: trackingMessageId }).catch(() => {});
          });
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
        isLeader = true;
        startTelegramBot();
      }
    } catch (e) {}
  } else if (lockData.pid === process.pid) {
    try {
      fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, timestamp: now }));
    } catch (e) {}
  } else {
    if (isLeader) {
      isLeader = false;
      stopTelegramBot();
    }
  }
} catch(e) {
  console.error("[Telegram] syncLoop error:", e);
} finally {
  syncLoopRunning = false;
}
}

function stopTelegramBot() {
  if (bot) {
    try {
      bot.stopPolling();
    } catch(e) {}
    bot = null;
    delete (globalThis as any).__sessionTrackerBot;
  }
}

function startTelegramBot() {
  if (bot) return;
  const config = loadConfig();
  if (!config) return;

  const state = readState();
  if (state.lastSessionsMessage) {
    lastSessionsMessage = state.lastSessionsMessage;
  }
  if (state.lastProjectsMessage) {
    lastProjectsMessage = state.lastProjectsMessage;
  }
  bot = new TelegramBot(config.token, { polling: true });
  (globalThis as any).__sessionTrackerBot = bot;

  bot.on('polling_error', (error: any) => {
    console.error("[Telegram] Polling error:", error.code, error.message);
    try {
      fs.appendFileSync(path.join(os.homedir(), 'telegram-polling-error.log'), `${new Date().toISOString()} - ${error.code} - ${error.message}\n`);
    } catch(e) {}
  });

  bot.on('error', (error: any) => {
    console.error("[Telegram] General error:", error?.message || String(error));
    try {
      fs.appendFileSync(path.join(os.homedir(), 'telegram-polling-error.log'), `${new Date().toISOString()} - GENERAL ERROR - ${error?.message || String(error)}\n`);
    } catch(e) {}
  });

  // Set bot commands for default scope AND all_private_chats scope
  // WARNING: Previously cleared scopes (like all_private_chats) still persist
  // on Telegram's server and override the default scope for private chats.
  // We must explicitly set commands for all_private_chats too.
  const cmds = [
    { command: '/projects', description: 'List & select active projects' },
    { command: '/sessions', description: 'List & select sessions' },
    { command: '/models', description: 'Select a model to use' },
    { command: '/recap', description: 'Recap current session via AI' },
    { command: '/help', description: 'List available OpenCode slash commands' }
  ];
  
  // Set for default scope
  bot!.setMyCommands(cmds).catch(err => console.error("[Telegram] setMyCommands default error", err));
  // Set for all_private_chats (overrides any stale empty scope from previous clears)
  bot!.setMyCommands(cmds, { scope: { type: 'all_private_chats' } as any }).catch(err => console.error("[Telegram] setMyCommands private error", err));

  bot.onText(/^\/projects/, async (msg) => {
    if (!allowedUsers.includes(msg.chat.id)) return;
    await handleProjectsCommand(msg.chat.id);
  });

  bot.onText(/^\/models/, async (msg) => {
    if (!allowedUsers.includes(msg.chat.id)) return;
    await handleModelsCommand(msg.chat.id);
  });

  bot.onText(/^\/help/, async (msg) => {
    if (!allowedUsers.includes(msg.chat.id)) return;
    await handleHelpCommand(msg.chat.id);
  });

  bot.onText(/^\/sessions/, async (msg) => {
    if (!allowedUsers.includes(msg.chat.id)) return;
    await handleSessionsCommand(msg.chat.id);
  });

  bot.onText(/^\/start/, async (msg) => {
    if (!allowedUsers.includes(msg.chat.id)) return;
    bot?.sendMessage(msg.chat.id, "👋 OpenCode Telegram Bot Connected!\n\nUse /projects to select a project, and /sessions to view contexts.");
  });

  bot.onText(/^\/recap/, async (msg) => {
    if (!allowedUsers.includes(msg.chat.id)) return;
    await handleRecapCommand(msg.chat.id);
  });

  bot.on('message', async (msg) => {
    if (!msg.from || !allowedUsers.includes(msg.from.id)) return;
    if (!msg.text) return;

    const text = msg.text.trim();

    if (text.startsWith('/')) {
      // Known bot-level commands are handled by their own onText handlers above
      const knownCommands = ['/projects', '/sessions', '/models', '/recap', '/help', '/start'];
      if (knownCommands.some(c => text === c || text.startsWith(c + ' '))) return;

      // Check if it's a registered OpenCode slash command
      try {
        const dir = activeProjectDir || apiRef.state.path.directory;
        const cmdRes = await apiRef.client.command.list({ location: { directory: dir } });
        const commands: any[] = (cmdRes?.data?.data || cmdRes?.data || []);
        const slashName = text.startsWith('/') ? text.slice(1).split(/\s+/)[0] : '';
        const matched = commands.find((c: any) => c.name === slashName);
        if (matched) {
          logDebug(`[bot.on('message')] Dispatching OpenCode slash command: /${slashName}`);
          await handleIncomingText(msg.chat.id, msg.message_id, text);
          return;
        }
      } catch(e) {
        logDebug(`[bot.on('message')] Failed to fetch commands for slash routing: ${e}`);
      }

      // Unknown slash command
      bot?.sendMessage(msg.chat.id, `⚠️ <code>${escapeHtml(text)}</code> — command not found.\n\nSend /help to see available OpenCode slash commands.`, {
        reply_to_message_id: msg.message_id,
        parse_mode: 'HTML'
      }).catch(() => {});
      return;
    }

    logDebug(`[bot.on('message')] chatId=${msg.chat.id} text="${text}"`);
    await handleIncomingText(msg.chat.id, msg.message_id, text);
  });

  bot.on('callback_query', async (query) => {
    if (!query.from || !allowedUsers.includes(query.from.id)) return;
    if (!query.data || !query.message) return;

    if (query.data.startsWith('nav_')) {
      // Reject if this is not the latest sessions message
      if (lastSessionsMessage && query.message.message_id !== lastSessionsMessage.messageId) {
        bot?.answerCallbackQuery(query.id, { text: "Menu outdated. Send /sessions again." });
        return;
      }
      const targetId = query.data.replace('nav_', '');
      const sId = targetId === 'home' ? null : targetId;
      const targetDir = activeProjectDir || apiRef.state.path.directory;
      try {
         // Write sync AND activeSessions atomically so keyboard reads correct → immediately
         const state = readState();
         state.sync = { type: 'navigate', targetDir, sessionId: sId, timestamp: Date.now() };
         state.activeSessions = state.activeSessions || {};
         state.activeSessions[targetDir] = sId;
         writeState(state);

        bot?.answerCallbackQuery(query.id, { text: "Session switched." });
        
        try {
          if (lastSessionsMessage && lastSessionsMessage.chatId === query.message.chat.id) {
              const sessKb = await getSessionsKeyboard();
              bot?.editMessageReplyMarkup({ inline_keyboard: sessKb }, { chat_id: lastSessionsMessage.chatId, message_id: lastSessionsMessage.messageId }).catch(() => {});
          }
        } catch(e) {}
      } catch (e) {
        bot?.answerCallbackQuery(query.id, { text: "Failed to navigate" });
      }
    } else if (query.data.startsWith('proj_select_')) {
      // Reject if this is not the latest projects message
      if (lastProjectsMessage && query.message.message_id !== lastProjectsMessage.messageId) {
        bot?.answerCallbackQuery(query.id, { text: "Menu outdated. Send /projects again." });
        return;
      }
      const shortId = query.data.replace('proj_select_', '');
      const targetDir = projectIds.get(shortId);
      if (targetDir) {
          activeProjectDir = targetDir;
          bot?.answerCallbackQuery(query.id, { text: `Project selected: ${path.basename(activeProjectDir)}` });
          try {
             const kb = await getProjectsKeyboard();
             bot?.editMessageReplyMarkup({ inline_keyboard: kb }, { chat_id: query.message.chat.id, message_id: query.message.message_id }).catch(() => {});
             
             // Only auto-update sessions if the sessions message was sent after this projects message
             if (lastSessionsMessage && lastSessionsMessage.chatId === query.message.chat.id &&
                 lastProjectsMessage && lastSessionsMessage.timestamp > lastProjectsMessage.timestamp) {
                 const sessKb = await getSessionsKeyboard();
                 try {
                   await bot?.editMessageReplyMarkup({ inline_keyboard: sessKb }, { chat_id: lastSessionsMessage.chatId, message_id: lastSessionsMessage.messageId });
                 } catch(e) {
                   bot?.deleteMessage(lastSessionsMessage.chatId, lastSessionsMessage.messageId).catch(()=>{});
                   lastSessionsMessage = null;
                   await handleSessionsCommand(query.message.chat.id);
                }
            }
          } catch(e) {}
      } else {
          bot?.answerCallbackQuery(query.id, { text: "Project not found. Run /projects again." });
      }
    } else if (query.data.startsWith('perm_allow_') || query.data.startsWith('perm_deny_')) {
      const isAllow = query.data.startsWith('perm_allow_');
      const shortId = query.data.replace(isAllow ? 'perm_allow_' : 'perm_deny_', '');
      const req = permissionRequests.get(shortId);
      
      if (!req) {
         bot?.answerCallbackQuery(query.id, { text: "Permission request expired or invalid." });
         return;
      }
      
      try {
        await apiRef.client.permission.reply({
           requestID: req.permId,
           reply: isAllow ? "once" : "reject"
        });
        bot?.answerCallbackQuery(query.id, { text: isAllow ? "✅" : "❌" });
        permissionRequests.delete(shortId);
      } catch (e) {
        bot?.answerCallbackQuery(query.id, { text: "Error" });
      }
     } else if (query.data.startsWith('qa_')) {
      const qfId = query.data.split('_')[1];
      const optIndex = parseInt(query.data.split('_')[2]);
      const flow = qfMap.get(qfId);
      if (!flow) {
        bot?.answerCallbackQuery(query.id, { text: "Question expired." });
        return;
      }
      const q = flow.questions[flow.currentIndex];
      const selectedLabel = q.options[optIndex].label;
      flow.answers.push([selectedLabel]);
      flow.currentIndex++;
      if (flow.currentIndex < flow.questions.length) {
        sendQuestionMessage(flow);
        bot?.answerCallbackQuery(query.id, { text: `✅ ${selectedLabel}` });
      } else {
        submitQuestionFlow(flow);
        bot?.answerCallbackQuery(query.id, { text: "✅ All answered!" });
      }
    } else if (query.data.startsWith('qtext_')) {
      const qfId = query.data.split('_')[1];
      const flow = qfMap.get(qfId);
      if (!flow) {
        bot?.answerCallbackQuery(query.id, { text: "Expired." });
        return;
      }
      flow.textMode = true;
      const q = flow.questions[flow.currentIndex];
      const num = flow.questions.length > 1 ? ` (${flow.currentIndex + 1}/${flow.questions.length})` : '';
      const msg = `📌 *${flow.title}*${num}\n\n${q.question}\n\n✏️ *Type your answer as a message.*`;
      bot?.editMessageText(msg, {
        chat_id: flow.chatId,
        message_id: flow.messageId!,
        parse_mode: 'Markdown'
      }).catch(() => {});
      bot?.answerCallbackQuery(query.id, { text: "Type your answer as a message." });
    } else if (query.data.startsWith('qc_')) {
      const qfId = query.data.split('_')[1];
      const flow = qfMap.get(qfId);
      if (flow) {
        cancelQuestionFlow(flow);
      }
      bot?.answerCallbackQuery(query.id, { text: "Cancelled" });
    } else if (query.data.startsWith('model_select_')) {
      const shortId = query.data.replace('model_select_', '');
      const entry = modelIds.get(shortId);
      if (!entry) {
        bot?.answerCallbackQuery(query.id, { text: "Model list expired. Send /models again." });
        return;
      }
      const { providerID, modelID } = entry;
      selectedModel = { providerID, modelID };
      try {
        const targetDir = activeProjectDir || apiRef.state.path.directory;
        let currentActive = null;
        try { currentActive = readState().activeSessions?.[targetDir] || null; } catch(e) {}
        if (currentActive) {
          try {
            await apiRef.client.session.switchModel({
              sessionID: currentActive,
              model: { id: modelID, providerID }
            });
            saveSessionModel(currentActive, providerID, modelID);
          } catch(e) {
            updateState('sync', {
              type: 'model_change',
              targetDir, sessionId: currentActive, providerID, modelID,
              timestamp: Date.now()
            });
            saveSessionModel(currentActive, providerID, modelID);
          }
        }
      } catch(e) {}
      
      try {
         if (query.message) {
            const kb = await getModelsKeyboard();
            bot?.editMessageReplyMarkup({ inline_keyboard: kb }, { chat_id: query.message.chat.id, message_id: query.message.message_id }).catch(() => {});
         }
      } catch(e) {}
      
      bot?.answerCallbackQuery(query.id, { text: `✅ Model: ${modelID}` });
    }
  });
}

export function initTelegram(api: any) {
  logDebug('initTelegram called');
  apiRef = api;
  const config = loadConfig();
  if (!config) return;

  allowedUsers = config.allowedUsers;
  
  // Handle Vite HMR to prevent multiple polling instances
  if (import.meta && (import.meta as any).hot) {
    (import.meta as any).hot.dispose(() => {
      stopTelegramBot();
    });
  }
  
  if (!activeProjectDir && apiRef.state.path.directory) {
      activeProjectDir = apiRef.state.path.directory;
  }

  if (!leaderInterval) {
    syncLoop();
    leaderInterval = setInterval(syncLoop, 1000);
  }
}

async function getProjectsKeyboard() {
  const dirs = new Set<string>();
  
  if (apiRef.state.path.directory) {
      dirs.add(apiRef.state.path.directory);
  }
  
  const state = readState();
  const projects = state.projects || {};
  const now = Date.now();
  for (const [dir, ts] of Object.entries(projects)) {
      if (now - (ts as number) < 86400000) {
          dirs.add(dir);
      }
  }
  
  try {
      const response = await apiRef.client.session.list({ query: { limit: 100 } });
      let sessions = response.data || response || [];
      if (Array.isArray(sessions)) {
          sessions.forEach((s: any) => {
              if (s.directory) dirs.add(s.directory);
          });
      }
  } catch(e) {}
  
  const inlineKeyboard: any[][] = [];
  
  Array.from(dirs).forEach(dir => {
      const isSelected = activeProjectDir === dir;
      const title = path.basename(dir) || dir;
      
      let hash = 5381;
      for (let i = 0; i < dir.length; i++) {
        hash = ((hash << 5) + hash) + dir.charCodeAt(i);
      }
      const shortId = Math.abs(hash).toString(16);
      
      projectIds.set(shortId, dir);
      inlineKeyboard.push([{ text: `${isSelected ? '→ ' : ''}${title}`, callback_data: `proj_select_${shortId}` }]);
  });
  
  return inlineKeyboard;
}

async function getSessionsKeyboard() {
  const queryDir = activeProjectDir || apiRef.state.path.directory;
  let sessions: any[] = [];
  
  // Cross-daemon offline retrieval: local daemon only surfaces its own project's sessions.
  // We read directly from SQLite global store so we can retrieve sessions for other directories even if they are closed.
  try {
    const dbPath = path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db');
    if (fs.existsSync(dbPath)) {
      const query = `SELECT id, title, parent_id as parentID, time_updated as timeUpdated, time_archived as timeArchived FROM session WHERE directory = '${queryDir.replace(/'/g, "''")}' ORDER BY time_updated DESC LIMIT 50`;
      const { stdout } = await execAsync(`sqlite3 -json "${dbPath}" "${query}"`);
      if (stdout.trim()) {
        const rawSessions = JSON.parse(stdout);
        sessions = rawSessions.map((row: any) => ({
          id: row.id,
          title: row.title,
          parentID: row.parentID,
          time: { updated: row.timeUpdated },
          status: row.timeArchived ? "deleted" : "active"
        }));
        console.log(`[Telegram] Fetched ${sessions.length} sessions from SQLite for ${queryDir}.`);
      }
    }
  } catch (e) {
    console.error("[Telegram] SQLite session fetch failed:", e);
  }

  // Fallback to API
  if (sessions.length === 0) {
    try {
      const response = await apiRef.client.session.list({ query: { directory: queryDir, limit: 50 } });
      sessions = response.data || response || [];
      if (!Array.isArray(sessions)) sessions = [];
      console.log(`[Telegram] Fetched ${sessions.length} sessions from daemon for ${queryDir}.`);
    } catch(e) {}
  }

  const now = Date.now();
  const MAX_AGE = 30 * 24 * 60 * 60 * 1000; // 30 days
  sessions = sessions.filter((s: any) => {
    if (s.status === "deleted") return false;
    if (!s.title || s.title.trim() === "") return false;
    const updatedTime = typeof s.time?.updated === 'number' ? s.time.updated : 0;
    return now - updatedTime < MAX_AGE;
  });

  console.log(`[Telegram] Filtered sessions (last 7 days, non-deleted, with title): ${sessions.length}`);

  const parents = sessions.filter((s: any) => !s.parentID);
  const parentMap = new Map();
  parents.forEach((p: any) => {
      p.subagents = [];
      parentMap.set(p.id, p);
  });
  
  sessions.filter((s: any) => s.parentID).forEach((s: any) => {
      const parent = parentMap.get(s.parentID);
      if (parent) {
          parent.subagents.push(s);
      } else {
          s.subagents = [];
          parents.push(s);
          parentMap.set(s.id, s);
      }
  });

  parents.sort((a: any, b: any) => {
      return (b.time?.updated || 0) - (a.time?.updated || 0);
  });

  const inlineKeyboard: any[][] = [];
  let currentActive = null;
  try { currentActive = readState().activeSessions?.[queryDir] || null; } catch(e) {}
  const isHomeSelected = currentActive === null;
  inlineKeyboard.push([{ text: `${isHomeSelected ? '→ ' : ''}🏠 Home (New Session)`, callback_data: "nav_home" }]);
  
  parents.slice(0, 15).forEach((p: any) => {
    const isCurrent = currentActive === p.id;
    const st = getSessionStatus(p.id);
    const ball = statusIcon(st);
    const title = (p.title || p.id).slice(0, 20);
    inlineKeyboard.push([{ text: `${isCurrent ? '→ ' : ''}${ball} ${title}`, callback_data: `nav_${p.id}` }]);
  });
  
  return inlineKeyboard;
}

async function handleProjectsCommand(chatId: number) {
  try {
    if (lastProjectsMessage) {
      let txt = "📁 Projects:";
      try {
        const state = readState();
        const dirs = state.projects ? Object.keys(state.projects) : [];
        const currentBase = activeProjectDir ? path.basename(activeProjectDir) : '';
        txt += '\n' + dirs.map(d => {
          const name = path.basename(d) || d;
          return activeProjectDir === d ? `→ ${name}` : name;
        }).join('\n');
      } catch(e) {}
      bot?.editMessageText(txt, { chat_id: lastProjectsMessage.chatId, message_id: lastProjectsMessage.messageId }).catch(() => {});
    }
    
    const inlineKeyboard = await getProjectsKeyboard();
    const sentMsg = await bot?.sendMessage(chatId, "📁 Projects:", {
      reply_markup: {
        inline_keyboard: inlineKeyboard
      }
    });
    if (sentMsg) {
       lastProjectsMessage = { chatId: sentMsg.chat.id, messageId: sentMsg.message_id, timestamp: Date.now() };
       updateState('lastProjectsMessage', lastProjectsMessage);
    }
    
    await handleSessionsCommand(chatId);
  } catch (err) {
    bot?.sendMessage(chatId, "❌ Failed to list projects.").catch(() => {});
  }
}

async function handleSessionsCommand(chatId: number) {
  try {
    if (lastSessionsMessage) {
      let txt = "🗂 Sessions:";
      try {
        const staleKb = await getSessionsKeyboard();
        if (staleKb.length > 0) {
          txt += '\n' + staleKb.map(row => row[0].text).join('\n');
        }
      } catch(e) {}
      bot?.editMessageText(txt, { chat_id: lastSessionsMessage.chatId, message_id: lastSessionsMessage.messageId }).catch(() => {});
    }
    
    const inlineKeyboard = await getSessionsKeyboard();
    const sentMsg = await bot?.sendMessage(chatId, "🗂 Sessions:", {
      reply_markup: {
        inline_keyboard: inlineKeyboard
      }
    });
    if (sentMsg) {
       lastSessionsMessage = { chatId: sentMsg.chat.id, messageId: sentMsg.message_id, timestamp: Date.now() };
       updateState('lastSessionsMessage', lastSessionsMessage);
    }
  } catch (err) {
    bot?.sendMessage(chatId, "❌ Failed to list sessions.").catch(() => {});
  }
}

async function handleModelsCommand(chatId: number) {
  try {
    if (lastModelsMessage) {
      bot?.editMessageText("🧠 Models:", { chat_id: lastModelsMessage.chatId, message_id: lastModelsMessage.messageId }).catch(() => {});
    }
    const inlineKeyboard = await getModelsKeyboard();
    const sentMsg = await bot?.sendMessage(chatId, "🧠 Models:", {
      reply_markup: { inline_keyboard: inlineKeyboard }
    });
    if (sentMsg) {
       lastModelsMessage = { chatId: sentMsg.chat.id, messageId: sentMsg.message_id, timestamp: Date.now() };
    }
  } catch (err: any) {
    bot?.sendMessage(chatId, `❌ Failed to list models: ${err?.message || String(err)}`).catch(() => {});
  }
}

async function handleHelpCommand(chatId: number) {
  try {
    const dir = activeProjectDir || apiRef.state.path.directory;
    logDebug(`[handleHelpCommand] fetching commands for dir=${dir}`);
    let cmdRes: any;
    try {
      cmdRes = await apiRef.client.command.list({ location: { directory: dir } });
    } catch (listErr: any) {
      logDebug(`[handleHelpCommand] command.list threw: ${listErr?.message || listErr}`);
      bot?.sendMessage(chatId, `❌ Failed to list commands: ${escapeHtml(String(listErr?.message || listErr))}`, { parse_mode: 'HTML' }).catch(() => {});
      return;
    }
    logDebug(`[handleHelpCommand] cmdRes=${JSON.stringify(cmdRes)?.slice(0, 300)}`);
    const commands: any[] = (cmdRes?.data?.data || cmdRes?.data || cmdRes || []);
    logDebug(`[handleHelpCommand] commands count=${Array.isArray(commands) ? commands.length : 'not-array'}`);

    if (!Array.isArray(commands) || commands.length === 0) {
      bot?.sendMessage(chatId, 'ℹ️ No slash commands are registered in this project.').catch(() => {});
      return;
    }

    const lines: string[] = ['📋 <b>Available slash commands:</b>\n'];
    for (const cmd of commands) {
      lines.push(`<code>/${escapeHtml(cmd.name)}</code>`);
      if (cmd.description) {
        lines.push(`  <i>${escapeHtml(cmd.description)}</i>`);
      }
      lines.push('');
    }
    lines.push('<i>Send any of these as a message to execute it in the active session.</i>');

    // Split into chunks that fit within Telegram's 4096 char limit
    const fullText = lines.join('\n');
    const chunks: string[] = [];
    let current = '';
    for (const line of lines) {
      if ((current + '\n' + line).length > 3800) {
        chunks.push(current);
        current = line;
      } else {
        current = current ? current + '\n' + line : line;
      }
    }
    if (current) chunks.push(current);

    for (const chunk of chunks) {
      await bot?.sendMessage(chatId, chunk, { parse_mode: 'HTML' }).catch((e: any) => {
        logDebug(`[handleHelpCommand] sendMessage error: ${e?.message || e}`);
      });
    }
  } catch (err: any) {
    logDebug(`[handleHelpCommand] outer error: ${err?.message || err}`);
    bot?.sendMessage(chatId, `❌ Failed to list commands: ${escapeHtml(String(err?.message || err))}`, { parse_mode: 'HTML' }).catch(() => {});
  }
}

async function handleRecapCommand(chatId: number) {
  const targetDir = activeProjectDir || apiRef.state.path.directory;
  let currentActive = null;
  try { currentActive = readState().activeSessions?.[targetDir] || null; } catch(e) {}
  if (!currentActive) {
    bot?.sendMessage(chatId, "⚠️ No active session. Use /sessions to select one.");
    return;
  }
  try {
    const statusMsg = await bot?.sendMessage(chatId, "⏳ Generating recap...");
    if (!statusMsg) return;
    
    const timeoutId = setTimeout(() => {
      bot?.editMessageText("*Recap timed out. Try again.*", { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: 'Markdown' }).catch(() => {});
    }, 60000);
    
    const recapText = await doRecap(currentActive);
    clearTimeout(timeoutId);
    
    if (!recapText) {
      bot?.editMessageText("*Recap failed.*", { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: 'Markdown' }).catch(() => {});
      return;
    }
    
    let footer = "";
    try {
      const sRes = await apiRef.client.session.get({ sessionID: currentActive, directory: targetDir });
      footer = buildFooter(sRes?.data || sRes);
    } catch(e) {}
    
    const formattedText = recapText
      .replace(/^Done:/gm, '**Done:**')
      .replace(/^Next:/gm, '**Next:**')
      .replace(/^Working on: /gm, '');
    
    let title = "Session";
    try { const sD = (await apiRef.client.session.get({ sessionID: currentActive }))?.data; if (sD?.title) title = sD.title; } catch(e) {}
    
    bot?.editMessageText(`📝 **${title}**\n\n${formattedText}${footer}`, { chat_id: chatId, message_id: statusMsg!.message_id, parse_mode: 'Markdown' }).catch(() => {});
  } catch (err) {
    bot?.sendMessage(chatId, "❌ Failed to generate recap.").catch(() => {});
  }
}

async function doRecap(sessionId: string): Promise<string | null> {
  try {
    const msgsRes = await apiRef.client.session.messages({ sessionID: sessionId, limit: 20 });
    const messages = msgsRes?.data || msgsRes || [];
    const msgList = Array.isArray(messages) ? messages : [];
    const transcript = msgList.map((m: any) => {
      const info = m.info || m; const role = info.role || "unknown";
      const text = (m.parts || []).filter((p: any) => p.type === "text").map((p: any) => p.text || "").join(" ").trim();
      return text ? `${role}: ${text}` : null;
    }).filter(Boolean).slice(-10).join("\n\n");
    if (!transcript) return null;
    let recapModel: { providerID: string; modelID: string } | undefined;
    const lastAssistant = [...msgList].reverse().find((m: any) => { const i = m.info || m; return (i.role || m.role) === "assistant" && i?.providerID && i?.modelID; });
    if (lastAssistant) { const i = lastAssistant.info || lastAssistant; recapModel = { providerID: i.providerID, modelID: i.modelID }; }
    if (!recapModel) { try { const c = apiRef.state.config?.model; if (typeof c === 'string' && c.includes('/')) { const p = c.split('/'); recapModel = { providerID: p[0], modelID: p.slice(1).join('/') }; } } catch(e) {} }
    const recapSession = await apiRef.client.session.create({});
    const recapSessionId = recapSession.data?.id || recapSession.id;
    if (!recapSessionId) return null;
    const prompt = `Summarize this coding session in ~100 words:\n\nWhat's being worked on, **Done:**, **Next:**.\n\nTranscript:\n${transcript}`;
    const opts: any = { sessionID: recapSessionId, parts: [{ type: "text", text: prompt }] };
    if (recapModel) opts.model = recapModel;
    await apiRef.client.session.prompt(opts);
    let recapText = "";
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 1000));
      const msgs = (await apiRef.client.session.messages({ sessionID: recapSessionId }))?.data || [];
      const list = Array.isArray(msgs) ? msgs : [];
      const last = [...list].reverse().find((m: any) => (m.info || m).role === "assistant");
      if (last) { recapText = (last.parts || []).filter((p: any) => p.type === "text").map((p: any) => p.text || "").join("").trim(); if (recapText) break; }
    }
    await apiRef.client.session.delete({ sessionID: recapSessionId }).catch(() => {});
    return recapText || null;
  } catch(e) { return null; }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatToolLine(name: string, input: string, status: string | undefined): string {
  const escInput = escapeHtml(input);
  const isRunning = status === 'running';

  let actionText = '';
  let emoji = '🔧';

  if (name === 'bash' || name === 'execute_command' || name === 'run_command') {
    emoji = '⚡';
    actionText = isRunning ? `Running: <code>$ ${escInput}</code>` : `Ran: <code>$ ${escInput}</code>`;
  } else if (name === 'read_file' || name === 'view_file') {
    emoji = '📄';
    actionText = isRunning ? `Reading: <code>${escInput}</code>` : `Read: <code>${escInput}</code>`;
  } else if (name === 'write_file' || name === 'create_file') {
    emoji = '📄';
    actionText = isRunning ? `Writing: <code>${escInput}</code>` : `Wrote: <code>${escInput}</code>`;
  } else if (name === 'edit_file' || name === 'replace_file_content' || name === 'multi_replace_file_content') {
    emoji = '📄';
    actionText = isRunning ? `Editing: <code>${escInput}</code>` : `Edited: <code>${escInput}</code>`;
  } else if (name === 'web_search' || name === 'search_web') {
    emoji = '🔍';
    actionText = isRunning ? `Searching: <i>${escInput}</i>` : `Searched: <i>${escInput}</i>`;
  } else {
    actionText = isRunning ? `Calling ${name}: <code>${escInput}</code>` : `Called ${name}`;
  }

  let suffix = '';
  if (isRunning) {
    suffix = ' ⏳';
  } else if (status === 'completed') {
    suffix = ' ✅';
  }

  return `${emoji} <i>${actionText}</i>${suffix}`;
}

function buildStatusFromParts(parts: any[]): string {
  const lines: string[] = [];

  for (const part of parts) {
    if (part.type === 'text') {
      const text = (part.text || '').trim();
      if (text) {
        const esc = escapeHtml(text);
        lines.push(esc.length > 500 ? '...' + esc.slice(-500) : esc);
      }
    } else if (part.type === 'reasoning') {
      const text = (part.text || '').trim();
      if (text) {
        const esc = escapeHtml(formatThinkingText(text));
        lines.push(`🧠 <i>Thinking: ${esc}</i>`);
      }
    } else if (part.type === 'tool') {
      const name = part.tool || 'unknown';
      const inputObj = part.state?.input || {};
      let input = '';
      if (typeof inputObj === 'object') {
        input = String(inputObj.CommandLine || inputObj.command || inputObj.cmd || inputObj.path || inputObj.query || inputObj.Query || '');
      } else {
        input = String(inputObj);
      }
      input = input.split('\n')[0].trim();
      if (input.length > 60) {
        input = input.slice(0, 60) + '...';
      }

      const status = part.state?.status;
      lines.push(formatToolLine(name, input, status));
    } else if (part.type === 'tool_call') {
      const name = part.name || '';
      const inputObj = part.input || part.arguments || {};
      let input = '';
      if (typeof inputObj === 'object') {
        input = String(inputObj.CommandLine || inputObj.command || inputObj.cmd || inputObj.path || inputObj.query || inputObj.Query || '');
      } else {
        input = String(inputObj);
      }
      input = input.split('\n')[0].trim();
      if (input.length > 60) {
        input = input.slice(0, 60) + '...';
      }

      lines.push(formatToolLine(name, input, 'running'));
    } else if (part.type === 'tool_result') {
      let lastRunningIdx = -1;
      for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i].includes('⏳')) {
          lastRunningIdx = i;
          break;
        }
      }
      if (lastRunningIdx !== -1) {
        let line = lines[lastRunningIdx];
        // Change Running to Ran, Reading to Read, Writing to Wrote, Editing to Edited, Searching to Searched, Calling to Called, and ⏳ to ✅
        line = line
          .replace('Running:', 'Ran:')
          .replace('Reading:', 'Read:')
          .replace('Writing:', 'Wrote:')
          .replace('Editing:', 'Edited:')
          .replace('Searching:', 'Searched:')
          .replace('Calling', 'Called')
          .replace('⏳', '✅');
        lines[lastRunningIdx] = line;
      }
    }
  }

  return lines.slice(-4).join('\n\n') || '⏳ Processing...';
}

async function buildMessageWithHeaderAndFooter(
  sessionId: string,
  bodyText: string,
  lastAssistant: any,
  promptTimestamp: number
): Promise<string> {
  let sessionTitle = '';
  try {
    const sRes = await apiRef.client.session.get({ sessionID: sessionId });
    sessionTitle = (sRes?.data || sRes)?.title || '';
  } catch(e) {}
  const header = sessionTitle ? `📌 <b>${escapeHtml(sessionTitle)}</b>\n\n` : '';

  const info = lastAssistant?.info || lastAssistant || {};
  const metaParts: string[] = [];

  // Agent Name
  let agentVal = info?.agent;
  if (!agentVal) {
    try { agentVal = readState().sessionAgents?.[sessionId]; } catch(e) {}
  }
  if (agentVal) metaParts.push(agentVal.split('-')[0].trim());

  // Model Name
  let modelVal = info?.model?.modelID || info?.modelID;
  if (!modelVal) {
    try { modelVal = readState().sessionModels?.[sessionId]?.modelID; } catch(e) {}
  }
  if (modelVal) metaParts.push(modelVal);

  // Duration
  const elapsedMs = Date.now() - promptTimestamp;
  const sec = elapsedMs / 1000;
  metaParts.push(sec < 60 ? `${sec.toFixed(1)}s` : `${Math.floor(sec/60)}m ${Math.round(sec%60)}s`);

  // Tokens
  const tok = info?.tokens?.total ||
              ((info?.tokens?.input || 0) + (info?.tokens?.output || 0)) ||
              ((info?.tokens_input || info?.tokensInput || 0) + (info?.tokens_output || info?.tokensOutput || 0));
  if (tok > 0) metaParts.push(`${(tok/1000).toFixed(1)}K`);
  if (info?.cost > 0) metaParts.push(`$${info.cost.toFixed(2)}`);

  const footer = metaParts.length > 0 ? `\n\n<i>${metaParts.join(' · ')}</i>` : '';

  return `${header}${bodyText}${footer}`;
}

function startPollingPrompt(
  sessionId: string,
  chatId: number,
  trackingMessageId: number,
  directory: string,
  promptTimestamp: number
) {
  logDebug(`[startPollingPrompt] start: sessionId=${sessionId} trackingMsgId=${trackingMessageId}`);
  // Cancel any existing polling/tracking for this session
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

  // Throttled edit
  const EDIT_THROTTLE_MS = 1200;
  let pendingEdit: ReturnType<typeof setTimeout> | null = null;

  // Register a finalizer so notifySessionIdle() can trigger it
  let finalizeRef: (() => void) | null = null;
  sessionFinalizers.set(sessionId, () => { if (finalizeRef) finalizeRef(); });

  function editMessageDirectly(text: string) {
    const safeText = text.slice(0, 4000);
    tracking.lastText = safeText;
    if (pendingEdit) { clearTimeout(pendingEdit); pendingEdit = null; }
    bot?.editMessageText(safeText, {
      chat_id: chatId,
      message_id: trackingMessageId,
      parse_mode: 'HTML'
    }).catch((err: any) => {
      const errMsg = err?.message || String(err);
      if (errMsg.includes("message is not modified")) return;
      bot?.editMessageText(safeText, {
        chat_id: chatId,
        message_id: trackingMessageId
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
        parse_mode: 'HTML'
      }).catch((err: any) => {
        const errMsg = err?.message || String(err);
        if (errMsg.includes("message is not modified")) return;
        bot?.editMessageText(safeText, {
          chat_id: chatId,
          message_id: trackingMessageId
        }).catch(() => {});
      });
    }, delay);
  }

  async function finalizeTracking() {
    if (tracking.isComplete) return;
    logDebug(`[finalizeTracking] start for sessionId=${sessionId}`);
    tracking.isComplete = true;
    if (pendingEdit) { clearTimeout(pendingEdit); pendingEdit = null; }
    if (tracking.timer) { clearInterval(tracking.timer); tracking.timer = null; }
    activeTrackings.delete(sessionId);
    sessionFinalizers.delete(sessionId);

    // Clear pendingPrompt from shared state
    try {
      const ns = readState();
      if (ns.pendingPrompt?.sessionId === sessionId) {
        delete ns.pendingPrompt;
        writeState(ns);
      }
    } catch(e) {}

    // Fetch the final response
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
        await new Promise(r => setTimeout(r, 1500));
      }
    } catch(e) {
      console.error('[Telegram] finalizeTracking error:', e);
    }
  }

  finalizeRef = () => { finalizeTracking().catch(() => {}); };

  // Start polling the messages and status
  tracking.timer = setInterval(async () => {
    try {
      if (tracking.isComplete) return;
      logDebug(`[polling tick] sessionId=${sessionId}`);

      // 1. Fetch recent messages
      const msgsRes = await apiRef.client.session.messages({ sessionID: sessionId, limit: 5 });
      const msgs = (msgsRes?.data || msgsRes || []) as any[];
      logDebug(`[polling tick] msgs fetched: count=${msgs.length}`);
      const lastAssistant = [...msgs].reverse().find((m: any) => {
        const role = (m.info || m).role;
        return role === 'assistant';
      });

      // 2. Fetch session status
      const statusRes = await apiRef.client.session.status({ directory });
      const statuses = statusRes?.data || statusRes || {};
      const sessionStatus = statuses[sessionId];
      const statusType = sessionStatus?.type || 'idle';
      logDebug(`[polling tick] statusType=${statusType}`);

      if (statusType === 'idle') {
        await finalizeTracking();
        return;
      }

      if (lastAssistant) {
        const statusText = buildStatusFromParts(lastAssistant.parts || []);
        const formattedMsg = await buildMessageWithHeaderAndFooter(sessionId, statusText, lastAssistant, promptTimestamp);
        scheduleEdit(formattedMsg);
      } else {
        const formattedMsg = await buildMessageWithHeaderAndFooter(sessionId, '⏳ Processing...', null, promptTimestamp);
        scheduleEdit(formattedMsg);
      }
    } catch (err) {
      console.error('[Telegram] Polling interval error:', err);
    }
  }, 1500);

  // Safety timeout: if nothing finishes within 5 minutes, force-finalize
  setTimeout(() => {
    if (!tracking.isComplete) {
      finalizeTracking().catch(() => {});
    }
  }, 5 * 60 * 1000);
}

/**
 * Called by the TUI plugin (index.tsx) when a session becomes idle.
 * Triggers finalization for any active Telegram tracking of that session.
 */
export function notifySessionIdle(sessionId: string) {
  const tracking = activeTrackings.get(sessionId);
  if (tracking && !tracking.isComplete) {
    // We need to call finalizeTracking() — but it's a closure inside subscribeToSessionEvents.
    // We signal completion via the isComplete flag; the inactivity timer will fire shortly.
    // Force immediate finalization by marking isComplete so the next timer tick runs.
    // Actually: store finalizers separately so we can call them externally.
    const finalizer = sessionFinalizers.get(sessionId);
    if (finalizer) finalizer();
  }
}

async function handleIncomingText(chatId: number, messageId: number | undefined, text: string) {
  logDebug(`[handleIncomingText] start: chatId=${chatId} text="${text}"`);
  try {
    for (const flow of qfMap.values()) {
      if (flow.chatId !== chatId) continue;
      const q = flow.questions[flow.currentIndex];
      if (!q.options || q.options.length === 0 || flow.textMode) {
        flow.textMode = false;
        flow.answers.push([text]);
        flow.currentIndex++;
        if (flow.currentIndex < flow.questions.length) {
          sendQuestionMessage(flow);
        } else {
          submitQuestionFlow(flow);
        }
        return;
      }
    }

    const targetDir = activeProjectDir || apiRef.state.path.directory;
    let currentActive: string | null = null;
    try { currentActive = readState().activeSessions?.[targetDir] || null; } catch(e) {}

    let sessionId: string | null = currentActive;

    if (!sessionId) {
      // Create a new session
      const createRes = await apiRef.client.session.create({ directory: targetDir });
      sessionId = createRes?.data?.id || createRes?.id || null;
      if (!sessionId) {
        bot?.sendMessage(chatId, '❌ Failed to create session.').catch(() => {});
        return;
      }
      updateCurrentSessionId(sessionId);
      // Notify TUI about the new session
      updateState('sync', {
        type: 'navigate',
        targetDir,
        sessionId,
        timestamp: Date.now()
      });
    }

    const trackingMsg = await bot?.sendMessage(chatId, '⏳ Processing...', {
      reply_to_message_id: messageId
    }).catch(() => null);

    const promptTimestamp = Date.now();

    const isLocal = (targetDir === apiRef.state.path.directory);

    if (isLocal) {
      // Send the prompt locally on the leader's client
      const promptOpts: any = {
        sessionID: sessionId,
        parts: [{ type: 'text', text }]
      };
      if (selectedModel) promptOpts.model = { providerID: selectedModel.providerID, modelID: selectedModel.modelID };
      logDebug(`[handleIncomingText] prompting locally: session=${sessionId} message="${text}"`);
      apiRef.client.session.prompt(promptOpts).catch((err: any) => {
        logDebug(`[handleIncomingText] session.prompt error: ${err?.message || err}`);
        console.error('[Telegram] session.prompt error:', err);
      });

      // Signal the local TUI to navigate to this session
      updateState('sync', {
        type: 'navigate',
        targetDir,
        sessionId,
        timestamp: Date.now()
      });
    } else {
      // Trigger the prompt cross-process on the target window's client
      logDebug(`[handleIncomingText] prompting cross-process: targetDir=${targetDir} session=${sessionId}`);
      updateState('sync', {
        type: 'prompt',
        targetDir,
        sessionId,
        text,
        model: selectedModel ? { providerID: selectedModel.providerID, modelID: selectedModel.modelID } : undefined,
        timestamp: Date.now()
      });
    }

    if (trackingMsg) {
      // Set pendingPrompt so the syncLoop fallback knows about it
      updateState('pendingPrompt', {
        chatId,
        trackingMessageId: trackingMsg.message_id,
        sessionId,
        directory: targetDir,
        text,
        timestamp: promptTimestamp,
        lastStatus: ''
      });

      if (isLocal) {
        // Start polling prompt execution directly — this drives real-time updates
        startPollingPrompt(sessionId, chatId, trackingMsg.message_id, targetDir, promptTimestamp);
      }
    }
  } catch (err) {
    bot?.sendMessage(chatId, '❌ Failed to send message.');
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
    try {
      const sRes = await apiRef.client.session.get({ sessionID: sessionId });
      footer = buildFooter(sRes?.data || sRes);
    } catch(e) {}
    
    let title = "Session";
    try {
      const sData = (await apiRef.client.session.get({ sessionID: sessionId }))?.data;
      if (sData?.title) title = sData.title;
    } catch(e) {}
    
    const replyOpts: any = { parse_mode: 'Markdown' };
    if (messageId) replyOpts.reply_to_message_id = messageId;
    
    bot?.sendMessage(chatId, `📝 **${title}**\n\n${displayText}${footer}`, replyOpts).catch(() => {});
  } catch(e) {}
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

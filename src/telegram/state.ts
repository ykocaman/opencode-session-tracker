import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';
import TelegramBot from 'node-telegram-bot-api';

export const INSTANCE_ID = crypto.randomUUID();

export const sessionFinalizers = new Map<string, () => void>();

export let bot: TelegramBot | null = (globalThis as any).__sessionTrackerBot || null;
export function setBot(newBot: TelegramBot | null) {
  bot = newBot;
  if (newBot) {
    (globalThis as any).__sessionTrackerBot = newBot;
  } else {
    delete (globalThis as any).__sessionTrackerBot;
  }
}

export let apiRef: any = null;
export function setApiRef(api: any) {
  apiRef = api;
}

export let currentSessionId: string | null = null;
export function setCurrentSessionIdVar(id: string | null) {
  currentSessionId = id;
}

export let allowedUsers: number[] = [];
export function setAllowedUsers(users: number[]) {
  allowedUsers = users;
}

export let selectedModel: any = null;
export function setSelectedModel(model: any) {
  selectedModel = model;
}

export let activeProjectDir: string | null = null;
export function setActiveProjectDir(dir: string | null) {
  activeProjectDir = dir;
}

export let isLeader = false;
export function setIsLeader(val: boolean) {
  isLeader = val;
}

export let leaderInterval: any = null;
export function setLeaderInterval(interval: any) {
  leaderInterval = interval;
}

export let lastSessionsMessage: { chatId: number, messageId: number, timestamp: number } | null = null;
export function setLastSessionsMessage(msg: typeof lastSessionsMessage) {
  lastSessionsMessage = msg;
}

export let lastProjectsMessage: { chatId: number, messageId: number, timestamp: number } | null = null;
export function setLastProjectsMessage(msg: typeof lastProjectsMessage) {
  lastProjectsMessage = msg;
}

export let lastHistoryMessage: { chatId: number, messageId: number, timestamp: number } | null = null;
export function setLastHistoryMessage(msg: typeof lastHistoryMessage) {
  lastHistoryMessage = msg;
}

export const STATE_DIR = path.join(os.homedir(), '.cache', 'opencode-session-tracker');
try {
  if (!fs.existsSync(STATE_DIR)) {
    fs.mkdirSync(STATE_DIR, { recursive: true });
  }
} catch(e) {}

export const LOCK_FILE = path.join(STATE_DIR, 'session-tracker.lock');
export const STATE_FILE = path.join(STATE_DIR, 'session-tracker.json');

export function logDebug(msg: string) {
  // Disabled in production
}

export function readState(): any {
  if (!fs.existsSync(STATE_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch(e) { return {}; }
}

export function writeState(data: any) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(data)); } catch(e) {}
}

export function updateState(key: string, value: any) {
  const state = readState();
  state[key] = value;
  writeState(state);
}

export function loadConfig() {
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

function heartbeatPath(dir: string): string {
  const hash = crypto.createHash('sha1').update(dir).digest('hex').slice(0, 12);
  return path.join(STATE_DIR, `heartbeat-${hash}.json`);
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export function updateActiveProjects() {
  const dir = apiRef?.state?.path?.directory;
  if (!dir) return;
  const data = JSON.stringify({ dir, pid: process.pid, timestamp: Date.now() });
  const target = heartbeatPath(dir);
  const tmp = target + '.' + process.pid + '.tmp';
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, target);
  } catch (e) {
    console.error('[Telegram] Failed to write heartbeat:', e);
  }
}

export function readActiveProjects(maxAgeMs = 45000): Record<string, { timestamp: number; pid: number }> {
  const out: Record<string, { timestamp: number; pid: number }> = {};
  let files: string[] = [];
  try { files = fs.readdirSync(STATE_DIR); } catch { return out; }
  const now = Date.now();
  for (const f of files) {
    if (!f.startsWith('heartbeat-')) continue;
    const fp = path.join(STATE_DIR, f);
    try {
      const h = JSON.parse(fs.readFileSync(fp, 'utf8'));
      if (now - h.timestamp > maxAgeMs || !alive(h.pid)) {
        try { fs.unlinkSync(fp); } catch {}
        continue;
      }
      out[h.dir] = { timestamp: h.timestamp, pid: h.pid };
    } catch {
      try { fs.unlinkSync(fp); } catch {}
    }
  }
  return out;
}

export function readProjectPid(dir: string): number | null {
  const active = readActiveProjects(45000);
  return active[dir]?.pid ?? null;
}

export function triggerSessionsMenuUpdate() {
  updateState('menuUpdateTimestamp', Date.now());
}

export function saveSessionStatus(sessionId: string, status: string) {
  try {
    const state = readState();
    const statuses = state.statuses || {};
    statuses[sessionId] = status;
    state.statuses = statuses;
    writeState(state);
    triggerSessionsMenuUpdate();
  } catch(e) {}
}

export function saveSessionModel(sessionId: string, providerID: string, modelID: string) {
  try {
    const state = readState();
    const sessionModels = state.sessionModels || {};
    sessionModels[sessionId] = { providerID, modelID, timestamp: Date.now() };
    state.sessionModels = sessionModels;
    writeState(state);
    triggerSessionsMenuUpdate();
  } catch(e) {}
}

export function getPromptStatusPath(sessionId: string): string {
  return path.join(STATE_DIR, `prompt-status-${sessionId}.json`);
}

export function savePromptStatus(sessionId: string, status: string) {
  try {
    const filePath = getPromptStatusPath(sessionId);
    fs.writeFileSync(filePath, JSON.stringify({ status, timestamp: Date.now(), isComplete: false }));
  } catch(e) {}
}

export function savePromptResponse(sessionId: string, text: string, info?: { title?: string; agent?: string; model?: string; duration?: number; tokens?: number; cost?: number }) {
  try {
    const filePath = getPromptStatusPath(sessionId);
    fs.writeFileSync(filePath, JSON.stringify({ text, info, timestamp: Date.now(), isComplete: true }));
  } catch(e) {}
}

export function updatePromptResponseMeta(sessionId: string, cost?: number, tokens?: number) {
  try {
    const filePath = getPromptStatusPath(sessionId);
    if (fs.existsSync(filePath)) {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (data.isComplete && data.info) {
        if (cost !== undefined) data.info.cost = cost;
        if (tokens !== undefined) data.info.tokens = tokens;
        fs.writeFileSync(filePath, JSON.stringify(data));
      }
    }
  } catch(e) {}
}

export function saveSessionAgent(sessionId: string, agent: string) {
  try {
    const state = readState();
    const sessionAgents = state.sessionAgents || {};
    sessionAgents[sessionId] = agent;
    state.sessionAgents = sessionAgents;
    writeState(state);
    triggerSessionsMenuUpdate();
  } catch(e) {}
}

export function setProjectStatusOverride(dir: string, status: string) {
  const state = readState();
  state.projectStatusOverrides = state.projectStatusOverrides || {};
  state.projectStatusOverrides[dir] = { status, timestamp: Date.now() };
  writeState(state);
}

export function clearProjectStatusOverride(dir: string) {
  const state = readState();
  if (state.projectStatusOverrides) {
    delete state.projectStatusOverrides[dir];
    writeState(state);
  }
}

export function cleanupStaleCacheFiles() {
  try {
    if (!fs.existsSync(STATE_DIR)) return;
    const files = fs.readdirSync(STATE_DIR);
    const now = Date.now();
    const EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours

    for (const file of files) {
      if (file.startsWith('prompt-status-') && file.endsWith('.json')) {
        const filePath = path.join(STATE_DIR, file);
        try {
          const stats = fs.statSync(filePath);
          if (now - stats.mtimeMs > EXPIRY_MS) {
            fs.unlinkSync(filePath);
          }
        } catch(e) {}
      }
    }
  } catch(e) {}
}

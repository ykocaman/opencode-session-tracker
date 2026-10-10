// Plugin runtime: module state that must survive opencode hot-reloads.
//
// Hot reload re-evaluates every module (wiping `let` bindings) but keeps
// `globalThis`. The Telegram polling bot lives there, so on reload we must
// RE-SYNC from globalThis + config instead of assuming fresh state.
// Saga lesson: startTelegramBot early-returned on the surviving bot while
// module-level allowedUsers reset to [] -> all notifies + incoming auth
// silently dead. bindSetup() below makes that impossible: every setup()
// re-binds ctx and reloads allowedUsers from disk, unconditionally.
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';
import TelegramBot from 'node-telegram-bot-api';

export const INSTANCE_ID = crypto.randomUUID();

const G = globalThis as any;
G.__stRuntime = G.__stRuntime || {};
const RT = G.__stRuntime;

export const STATE_DIR = path.join(os.homedir(), '.cache', 'opencode-session-tracker');
try {
  if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
} catch (e) {}

export const LOCK_FILE = path.join(STATE_DIR, 'session-tracker.lock');
/** Legacy single-JSON store (pre-rewrite). Read-only fallback for migration. */
export const LEGACY_STATE_FILE = path.join(STATE_DIR, 'session-tracker.json');

export function logDebug(_msg: string) {
  // Disabled in production
}

// --- Surviving state (mirrored to globalThis) ---

export let bot: TelegramBot | null = RT.bot || null;
export function setBot(newBot: TelegramBot | null) {
  bot = newBot;
  if (newBot) RT.bot = newBot;
  else delete RT.bot;
}

export let apiRef: any = RT.ctx || null;
export function setApiRef(api: any) {
  apiRef = api;
  RT.ctx = api;
}

export let allowedUsers: number[] = RT.allowedUsers || [];
export function setAllowedUsers(users: number[]) {
  allowedUsers = users;
  RT.allowedUsers = users;
}

export function isAllowed(userId: number): boolean {
  return allowedUsers.includes(userId);
}

// --- Ephemeral per-setup state (fresh on every reload is correct) ---

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

export let lastSessionsMessage: { chatId: number; messageId: number; timestamp: number } | null = null;
export function setLastSessionsMessage(msg: typeof lastSessionsMessage) {
  lastSessionsMessage = msg;
}

export let lastProjectsMessage: { chatId: number; messageId: number; timestamp: number } | null = null;
export function setLastProjectsMessage(msg: typeof lastProjectsMessage) {
  lastProjectsMessage = msg;
}

export let lastHistoryMessage: { chatId: number; messageId: number; timestamp: number } | null = null;
export function setLastHistoryMessage(msg: typeof lastHistoryMessage) {
  lastHistoryMessage = msg;
}

/** Monotonic setup counter — staleness guard for async work started pre-reload. */
export let setupVersion = 0;

export interface TelegramConfig {
  token: string;
  allowedUsers: number[];
}

export function loadConfig(): TelegramConfig | null {
  const configPath = path.join(os.homedir(), '.config', 'opencode', 'telegram.json');
  if (!fs.existsSync(configPath)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (data.token && Array.isArray(data.allowedUsers)) return data;
  } catch (err) {
    console.error('[Telegram] Error reading config', err);
  }
  return null;
}

/**
 * Called on EVERY plugin setup (including hot reloads). Re-binds ctx,
 * re-syncs the surviving bot, reloads allowedUsers from disk, resets
 * election state so this setup re-elects cleanly.
 */
export function bindSetup(ctx: any): TelegramConfig | null {
  setApiRef(ctx);
  setupVersion++;
  setIsLeader(false);
  setLeaderInterval(null);
  // Re-sync surviving globals (module lets were just re-initialized).
  bot = RT.bot || null;
  const cfg = loadConfig();
  setAllowedUsers(cfg?.allowedUsers || []);
  return cfg;
}

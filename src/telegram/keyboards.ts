import path from 'path';
import fs from 'fs';
import os from 'os';
import { execFile } from 'child_process';
import util from 'util';
import { DAY_MS, groupByParent, isListableSession, updatedAt } from '../sessions';
import { apiRef, activeProjectDir } from '../core/runtime';
import { readState } from '../core/store';
import { readActiveProjects } from '../core/leader';
import { getArchivedSessions, readSavedStatuses, saveSessionStatus } from '../core/status';
import { isHeartbeatFresh } from '../core/leader';
import { localRunStatus, pendingForms, pendingPermissions, sessionDirOf, unwrapSessionList, workdir } from '../core/ctx';

const execFileAsync = util.promisify(execFile);

export const projectIds = new Map<string, string>();
export const modelIds = new Map<string, string>();

const ONLINE_WINDOW_MS = 8000;
const ACTIVE_PROJECTS_WINDOW_MS = 45000;
const STATUS_OVERRIDE_WINDOW_MS = 15000;
const MAX_SESSION_BUTTONS = 15;

/** Short stable id for callback_data (Telegram limits it to 64 bytes). */
export function shortHash(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash) + text.charCodeAt(i);
  }
  return Math.abs(hash).toString(16);
}

const repairedStale = new Set<string>();

export function getSessionStatus(sessionId: string): string {
  try {
    if (pendingForms(sessionId).length > 0) return "ask";
    if (pendingPermissions(sessionId).length > 0) return "perm";
    const st = localRunStatus(sessionId);
    if (st && st !== "idle") return st === "running" ? "busy" : st;
  } catch (e) {}

  try {
    const saved = readSavedStatuses()[sessionId];
    if (saved && saved.status && saved.status !== "idle" && !repairedStale.has(sessionId)) {
      // Live store says idle but disk says active: trust live when the
      // session is known locally, otherwise only while the owning
      // instance's heartbeat is fresh — then repair the stale entry.
      let known = false;
      try { known = !!apiRef?.data?.session?.get?.(sessionId); } catch {}
      if (known || (saved.dir && !isHeartbeatFresh(saved.dir))) {
        repairedStale.add(sessionId);
        try { saveSessionStatus(sessionId, "idle"); } catch {}
        return "idle";
      }
    }
    if (saved?.status) return saved.status;
  } catch (e) {}

  return "idle";
}

export function statusIcon(status: string): string {
  switch (status) {
    case "busy": case "running": return "🟢";
    case "retry": case "waiting": return "🟡";
    case "ask": case "perm": return "🟣";
    case "error": return "🔴";
    default: return "⚪";
  }
}

const isInactiveStatus = (st: string) => st === 'idle' || st === 'done' || st === 'error' || st === '';

/** Current project dir plus its sibling directories (e.g. everything under ~/Projects). */
function discoverSiblingProjects(currentDir: string): string[] {
  try {
    const parentDir = path.dirname(currentDir);
    if (!fs.existsSync(parentDir)) return [];
    return fs.readdirSync(parentDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules')
      .map(d => path.join(parentDir, d.name));
  } catch (e) {
    console.error("[Telegram] Sibling project directory scan failed:", e);
    return [];
  }
}

export async function getProjectsKeyboard() {
  const dirs = new Set<string>();
  const currentDir = workdir();

  if (currentDir) {
    dirs.add(currentDir);
    discoverSiblingProjects(currentDir).forEach(d => dirs.add(d));
  }

  const now = Date.now();
  const active = readActiveProjects(ACTIVE_PROJECTS_WINDOW_MS);
  Object.keys(active).forEach(d => dirs.add(d));

  try {
    const response = await apiRef.client.session.list({ limit: 100 });
    const sessions = unwrapSessionList(response);
    sessions.forEach((s: any) => {
      const d = sessionDirOf(s);
      if (d) dirs.add(d);
    });
  } catch (e) {}

  const isOnline = (dir: string) => now - (active[dir]?.timestamp || 0) < ONLINE_WINDOW_MS;

  // Online projects first, then alphabetical by folder name.
  const sortedDirs = Array.from(dirs).sort((a, b) => {
    const onlineA = isOnline(a);
    const onlineB = isOnline(b);
    if (onlineA !== onlineB) return onlineA ? -1 : 1;
    return path.basename(a).toLowerCase().localeCompare(path.basename(b).toLowerCase());
  });

  const overrides = readState().projectStatusOverrides || {};
  const inlineKeyboard: any[][] = sortedDirs.map(dir => {
    const isSelected = (activeProjectDir === dir) || (!activeProjectDir && dir === currentDir);
    const title = path.basename(dir) || dir;

    // Status overrides: processing = yellow, closing = gray
    const override = overrides[dir];
    const icon = override && (now - override.timestamp < STATUS_OVERRIDE_WINDOW_MS)
      ? (override.status === 'processing' ? '🟡' : '⚪')
      : (isOnline(dir) ? '🟢' : '⚪');
    const arrow = isSelected && activeProjectDir ? '→ ' : '';

    const shortId = shortHash(dir);
    projectIds.set(shortId, dir);
    return [{ text: `${arrow}${icon} ${title}`, callback_data: `proj_select_${shortId}` }];
  });

  const currentSelected = activeProjectDir || currentDir;
  if (currentSelected) {
    if (isOnline(currentSelected)) {
      const row: any[] = [{ text: '📋 List Sessions', callback_data: 'proj_list_sessions' }];
      if (Object.keys(active).length > 1) {
        row.push({ text: '❌ Close', callback_data: 'proj_close' });
      }
      inlineKeyboard.push(row);
    } else {
      inlineKeyboard.push([{ text: '🚀 Launch OpenCode', callback_data: 'proj_launch' }]);
    }
  }

  return inlineKeyboard;
}

async function fetchSessionsFromSqlite(queryDir: string): Promise<any[]> {
  try {
    const dbPath = path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db');
    if (!fs.existsSync(dbPath)) return [];

    const query = `SELECT id, title, parent_id as parentID, time_updated as timeUpdated, time_archived as timeArchived FROM session_v2 WHERE directory = '${queryDir.replace(/'/g, "''")}' ORDER BY time_updated DESC LIMIT 50`;
    const { stdout } = await execFileAsync('sqlite3', ['-json', dbPath, query]);
    if (!stdout.trim()) return [];

    return JSON.parse(stdout).map((row: any) => ({
      id: row.id,
      title: row.title,
      parentID: row.parentID,
      time: { updated: row.timeUpdated },
      status: row.timeArchived ? "deleted" : "active"
    }));
  } catch (e) {
    console.error("[Telegram] SQLite session fetch failed:", e);
    return [];
  }
}

async function fetchSessionsFromApi(queryDir: string): Promise<any[]> {
  try {
    const response = await apiRef.client.session.list({ directory: queryDir, limit: 50 });
    return unwrapSessionList(response);
  } catch (e) {
    return [];
  }
}

export async function getSessionsKeyboard(showHistory: boolean = false) {
  const queryDir = activeProjectDir || workdir();

  let sessions = await fetchSessionsFromSqlite(queryDir);
  if (sessions.length === 0) sessions = await fetchSessionsFromApi(queryDir);

  const now = Date.now();
  sessions = sessions.filter(s => isListableSession(s, now));

  // Same active/history split the TUI sidebar uses (staleness threshold + manual archive
  // flag set via right-click), so a session bucketed into History in one surface is bucketed
  // into History in the other too.
  const archivedIds = getArchivedSessions();
  const filteredParents = groupByParent(sessions)
    .filter(p => {
      const isExpired = archivedIds.has(p.id) || now - updatedAt(p) >= DAY_MS;
      return showHistory ? isExpired : !isExpired;
    })
    .sort((a, b) => {
      const activeA = !isInactiveStatus(getSessionStatus(a.id));
      const activeB = !isInactiveStatus(getSessionStatus(b.id));
      if (activeA !== activeB) return activeA ? -1 : 1;
      return (b.time?.updated || 0) - (a.time?.updated || 0);
    });

  let currentActive: string | null = null;
  try { currentActive = readState().activeSessions?.[queryDir] || null; } catch (e) {}

  const inlineKeyboard: any[][] = [];

  if (!showHistory) {
    inlineKeyboard.push([{ text: `${currentActive === null ? '→ ' : ''}🏠 Home (New Session)`, callback_data: "nav_home" }]);
  }

  filteredParents.slice(0, MAX_SESSION_BUTTONS).forEach(p => {
    const arrow = currentActive === p.id ? '→ ' : '';
    const ball = statusIcon(getSessionStatus(p.id));
    const title = (p.title || p.id).slice(0, 20);
    inlineKeyboard.push([{ text: `${arrow}${ball} ${title}`, callback_data: `nav_${p.id}` }]);
  });

  if (currentActive && !showHistory) {
    const status = getSessionStatus(currentActive);
    if (status === 'busy' || status === 'running') {
      inlineKeyboard.push([{ text: "🔍 Tail Session", callback_data: "sess_tail" }]);
    } else if (status === 'ask' || status === 'perm') {
      inlineKeyboard.push([{ text: "❓ Show Question", callback_data: "sess_show_question" }]);
    } else {
      inlineKeyboard.push([{ text: "📝 Get Recap", callback_data: "sess_recap" }]);
    }
  }

  return inlineKeyboard;
}

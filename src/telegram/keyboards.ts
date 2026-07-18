import path from 'path';
import fs from 'fs';
import os from 'os';
import { exec } from 'child_process';
import util from 'util';
import { apiRef, readState, readActiveProjects, activeProjectDir } from './state';

const execAsync = util.promisify(exec);

export const projectIds = new Map<string, string>();
export const sessionIds = new Map<string, string>();
export const modelIds = new Map<string, string>();

export function getSessionStatus(sessionId: string): string {
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

export function statusIcon(status: string): string {
  switch(status) {
    case "busy": case "running": return "🟢";
    case "retry": case "waiting": return "🟡";
    case "ask": case "perm": return "🟣";
    case "error": return "🔴";
    default: return "⚪";
  }
}

export function getModelPriority(providerID: string, modelID: string, favorites: string[], recents: string[]): number {
  const modelStr = `${providerID}/${modelID}`;
  if (favorites.includes(modelStr)) return 100 - favorites.indexOf(modelStr);
  if (recents.includes(modelStr)) return 50 - recents.indexOf(modelStr);
  if (providerID === 'anthropic' && modelID.includes('claude-3-5-sonnet')) return 10;
  if (providerID === 'gemini' && modelID.includes('gemini-2.5-pro')) return 9;
  if (providerID === 'gemini' && modelID.includes('gemini-2.5-flash')) return 8;
  return 0;
}

export async function getProjectsKeyboard() {
  const dirs = new Set<string>();
  
  if (apiRef?.state?.path?.directory) {
      dirs.add(apiRef.state.path.directory);
      
      // Auto-scan parent directory to discover other sibling projects (e.g. under ~/Projects)
      try {
        const parentDir = path.dirname(apiRef.state.path.directory);
        if (fs.existsSync(parentDir)) {
          const siblings = fs.readdirSync(parentDir, { withFileTypes: true });
          for (const sibling of siblings) {
            if (sibling.isDirectory() && !sibling.name.startsWith('.') && sibling.name !== 'node_modules') {
              dirs.add(path.join(parentDir, sibling.name));
            }
          }
        }
      } catch(e) {
        console.error("[Telegram] Sibling project directory scan failed:", e);
      }
  }
  
  const now = Date.now();
  const active = readActiveProjects(45000);
  for (const dir of Object.keys(active)) {
      dirs.add(dir);
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
  
  // Sort directories:
  // 1. Current selected goes first.
  // 2. Active running (online) goes next.
  // 3. Offline goes after.
  // 4. Alphabetical by folder basename.
  const sortedDirs = Array.from(dirs).sort((a, b) => {
    const lastTsA = active[a]?.timestamp || 0;
    const lastTsB = active[b]?.timestamp || 0;
    const isOnlineA = (now - lastTsA < 8000);
    const isOnlineB = (now - lastTsB < 8000);
    if (isOnlineA && !isOnlineB) return -1;
    if (!isOnlineA && isOnlineB) return 1;

    const nameA = path.basename(a).toLowerCase();
    const nameB = path.basename(b).toLowerCase();
    return nameA.localeCompare(nameB);
  });

  const inlineKeyboard: any[][] = [];
  
  sortedDirs.forEach(dir => {
      const isSelected = (activeProjectDir === dir) || (!activeProjectDir && dir === apiRef?.state?.path?.directory);
      const title = path.basename(dir) || dir;
      const lastTs = active[dir]?.timestamp || 0;
      const isOnline = (now - lastTs < 8000);

      // Check for status overrides (processing = yellow, closing = gray)
      const overrides = readState().projectStatusOverrides || {};
      const override = overrides[dir];
      let statusIcon: string;
      if (override && (now - override.timestamp < 15000)) {
        statusIcon = override.status === 'processing' ? '🟡' : '⚪';
      } else {
        statusIcon = isOnline ? '🟢' : '⚪';
      }
      const arrow = isSelected && activeProjectDir ? '→ ' : '';
      const buttonText = `${arrow}${statusIcon} ${title}`;
      
      let hash = 5381;
      for (let i = 0; i < dir.length; i++) {
        hash = ((hash << 5) + hash) + dir.charCodeAt(i);
      }
      const shortId = Math.abs(hash).toString(16);
      
      projectIds.set(shortId, dir);
      inlineKeyboard.push([{ text: buttonText, callback_data: `proj_select_${shortId}` }]);
  });

  const currentSelected = activeProjectDir || apiRef?.state?.path?.directory;
  if (currentSelected) {
    const name = path.basename(currentSelected);
    const lastTs = active[currentSelected]?.timestamp || 0;
    const isOnline = (now - lastTs < 8000);
    if (isOnline) {
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

export async function getSessionsKeyboard(showHistory: boolean = false) {
  const queryDir = activeProjectDir || apiRef.state.path.directory;
  let sessions: any[] = [];
  
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
    } catch(e) {}
  }

  const now = Date.now();
  const EXPIRY_MS = 24 * 60 * 60 * 1000;
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
  
  sessions = sessions.filter((s: any) => {
    if (s.status === "deleted") return false;
    if (!s.title || s.title.trim() === "") return false;
    const updatedTime = typeof s.time?.updated === 'number' ? s.time.updated : 0;
    return now - updatedTime < WEEK_MS;
  });

  const sessionsMap = new Map();
  sessions.forEach((s: any) => {
      s.subagents = [];
      sessionsMap.set(s.id, s);
  });

  const findUltimateParent = (s: any) => {
      let current = s;
      let lastVisible = null;
      const visited = new Set();
      while (current.parentID && !visited.has(current.id)) {
          visited.add(current.id);
          const parent = sessionsMap.get(current.parentID);
          if (!parent) break;
          lastVisible = parent;
          current = parent;
      }
      return lastVisible;
  };

  const parents: any[] = [];
  sessions.forEach((s: any) => {
      const p = findUltimateParent(s);
      if (p) {
          p.subagents.push(s);
      } else {
          parents.push(s);
      }
  });

  parents.sort((a: any, b: any) => {
      return (b.time?.updated || 0) - (a.time?.updated || 0);
  });

  const filteredParents = parents.filter((p: any) => {
    const updatedTime = typeof p.time?.updated === 'number' ? p.time.updated : 0;
    const isExpired = now - updatedTime >= EXPIRY_MS;
    return showHistory ? isExpired : !isExpired;
  });

  filteredParents.sort((a: any, b: any) => {
    const stA = getSessionStatus(a.id);
    const stB = getSessionStatus(b.id);
    const isActiveA = stA !== 'idle' && stA !== 'done' && stA !== 'error' && stA !== '';
    const isActiveB = stB !== 'idle' && stB !== 'done' && stB !== 'error' && stB !== '';
    
    if (isActiveA && !isActiveB) return -1;
    if (!isActiveA && isActiveB) return 1;
    return (b.time?.updated || 0) - (a.time?.updated || 0);
  });

  const inlineKeyboard: any[][] = [];
  let currentActive = null;
  try { currentActive = readState().activeSessions?.[queryDir] || null; } catch(e) {}
  
  if (!showHistory) {
    const isHomeSelected = currentActive === null;
    inlineKeyboard.push([{ text: `${isHomeSelected ? '→ ' : ''}🏠 Home (New Session)`, callback_data: "nav_home" }]);
  }
  
  filteredParents.slice(0, 15).forEach((p: any) => {
    const isCurrent = currentActive === p.id;
    const st = getSessionStatus(p.id);
    const ball = statusIcon(st);
    const title = (p.title || p.id).slice(0, 20);
    inlineKeyboard.push([{ text: `${isCurrent ? '→ ' : ''}${ball} ${title}`, callback_data: `nav_${p.id}` }]);
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

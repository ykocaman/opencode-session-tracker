/** @jsxImportSource @opentui/solid */
import { createResource, onCleanup, For, Show, createSignal } from "solid-js";
import type { TuiSlotProps, TuiPluginApi } from "@opencode-ai/plugin/tui";
import { exec } from "child_process";
import { getTelegramStatus, updateCurrentSessionId } from "../telegram";
import { getStatusSignal } from "./signals";
import { SessionItem } from "./SessionItem";

let cachedSessions: any[] = [];
let cachedDir = '';

export function SessionSidebar(props: TuiSlotProps<"sidebar_content"> & { api: TuiPluginApi }) {
  const { api } = props;
  
  // Keep telegram in sync with the TUI's active session
  updateCurrentSessionId(props.session_id || null);
  const [expanded, setExpanded] = createSignal<Set<string>>(new Set());
  const [currentSessionId, setCurrentSessionId] = createSignal<string | undefined>(props.session_id);
  
  const initialStatus = getTelegramStatus();
  const [telegramStatus, setTelegramStatus] = createSignal<string>(initialStatus);
  const [showTelegramWarning, setShowTelegramWarning] = createSignal<boolean>(true);

  if (initialStatus === "missing") {
    setTimeout(() => {
      setShowTelegramWarning(false);
    }, 30000);
  }

  const toggleExpanded = (id: string) => {
      const newSet = new Set(expanded());
      if (newSet.has(id)) newSet.delete(id);
      else newSet.add(id);
      setExpanded(newSet);
  };

  const fetchSessions = async () => {
    const activeDir = api.state.path.directory;
    if (activeDir !== cachedDir) {
      cachedSessions = [];
      cachedDir = activeDir;
    }
    try {
      const response = await (api.client.session as any).list({ query: { directory: activeDir, limit: 30 } });
      const data = response.data || response || [];
      if (Array.isArray(data)) {
        cachedSessions = data;
      }
      return cachedSessions;
    } catch (err) {
      return cachedSessions;
    }
  };

  const activeDir = api.state.path.directory;
  const initialSessions = activeDir === cachedDir ? cachedSessions : [];
  const [rawSessions, { refetch }] = createResource(fetchSessions, {
    initialValue: initialSessions
  });
  
  const interval = setInterval(() => {
    refetch();
    // Sync active session from route (slot session_id may not be reactive)
    const currentRoute = api.route.current as any;
    if (currentRoute.name === "session" && currentRoute.params?.sessionID) {
      setCurrentSessionId(currentRoute.params.sessionID);
    }
  }, 3000);
  onCleanup(() => clearInterval(interval));
  
  const displaySessions = () => {
      let sessions = rawSessions() || [];
      const now = Date.now();
      const EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours since last update = expired
      const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
      
      const isExpired = (s: any) => {
         const updatedTime = typeof s.time?.updated === 'number' ? s.time.updated : 0;
         return now - updatedTime >= EXPIRY_MS;
      };
      
      sessions = sessions.filter((s: any) => {
         if (s.status === "deleted") return false;
         if (!s.title || s.title.trim() === "") return false;
         const updatedTime = typeof s.time?.updated === 'number' ? s.time.updated : 0;
         return now - updatedTime < WEEK_MS;
      });
      
      sessions.sort((a: any, b: any) => (b.time?.updated || 0) - (a.time?.updated || 0));
      
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
          let aActive = false;
          let bActive = false;
          
          const checkActive = (session: any) => {
              const [status] = getStatusSignal(session.id);
              const st = status();
              return st !== "idle" && st !== "done" && st !== "error";
          };
          
          if (checkActive(a)) aActive = true;
          a.subagents?.forEach((sub: any) => { if (checkActive(sub)) aActive = true; });
          
          if (checkActive(b)) bActive = true;
          b.subagents?.forEach((sub: any) => { if (checkActive(sub)) bActive = true; });
          
          if (aActive && !bActive) return -1;
          if (!aActive && bActive) return 1;
          return (b.time?.updated || 0) - (a.time?.updated || 0);
      });
      
      const list: any[] = [];
      parents.forEach((p: any) => {
          const hasSubs = p.subagents && p.subagents.length > 0;
          list.push({ ...p, isSubagent: false, hasSubagents: hasSubs, isExpired: isExpired(p) });
          
          const isExpanded = expanded().has(p.id);
          
          p.subagents.sort((a: any, b: any) => (b.time?.updated || 0) - (a.time?.updated || 0));
          
          const visibleSubs = p.subagents.filter((sub: any) => {
              if (isExpanded) return true;
              const [status] = getStatusSignal(sub.id);
              const questions = api.state.session.question(sub.id) || [];
              const permissions = api.state.session.permission(sub.id) || [];
              const st = api.state.session.status(sub.id);
              const apiType = questions.length > 0 ? "ask" : permissions.length > 0 ? "perm" : (typeof st === "string" ? st : (st?.type || "idle"));
              
              return status() !== "idle" || apiType !== "idle";
          });
          
          visibleSubs.forEach((sub: any, index: number) => {
              const isLast = index === visibleSubs.length - 1;
              list.push({ ...sub, isSubagent: true, isLastSubagent: isLast, isExpired: isExpired(p) });
          });
      });
      
      list.forEach((s: any) => {
        const [status, setStatus] = getStatusSignal(s.id);
        if (status() !== "idle") return;
        
        const questions = api.state.session.question(s.id) || [];
        const permissions = api.state.session.permission(s.id) || [];
        
        let currentType = "idle";
        if (questions.length > 0) {
            currentType = "ask";
        } else if (permissions.length > 0) {
            currentType = "perm";
        } else {
            const st = api.state.session.status(s.id);
            currentType = typeof st === "string" ? st : (st?.type || "idle");
        }
        
        setStatus(currentType);
      });
      
      return list;
  };
  
  const openUrl = (url: string) => {
    try {
      const start = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
      exec(`${start} ${url}`);
    } catch(e) {}
  };
  
  const allSessions = () => displaySessions() || [];
  const activeSessions = () => allSessions().filter((s: any) => !s.isExpired);
  const expiredSessions = () => allSessions().filter((s: any) => s.isExpired);
  
  const [historyExpanded, setHistoryExpanded] = createSignal<boolean>(false);

  return (
    <box flexDirection="column" marginTop={1} flexShrink={0}>
      <box flexDirection="row" flexShrink={0}>
        <box flexGrow={1}>
          <text fg="white"><b>Sessions</b></text>
        </box>
        <text fg="magenta" onMouseDown={() => api.route.navigate("home")}>[Home]</text>
      </box>
      <Show when={activeSessions().length === 0 && expiredSessions().length === 0}>
        <text fg="gray">No sessions found</text>
      </Show>
      <For each={activeSessions()}>
        {(session: any) => (
          <SessionItem 
            {...session} 
            currentSessionId={currentSessionId}
            setCurrentSessionId={setCurrentSessionId}
            expanded={expanded}
            toggleExpanded={toggleExpanded}
            api={api}
          />
        )}
      </For>
      <Show when={expiredSessions()?.length > 0}>
        <box flexDirection="row" gap={0} marginTop={1} onMouseDown={() => setHistoryExpanded(!historyExpanded())}>
          <text fg="gray">{historyExpanded() ? "[-] " : "[+] "}</text>
          <text fg="gray"><b>History</b></text>
        </box>
        <Show when={historyExpanded()}>
          <For each={expiredSessions()}>
            {(session: any) => (
              <SessionItem 
                {...session} 
                currentSessionId={currentSessionId}
                setCurrentSessionId={setCurrentSessionId}
                expanded={expanded}
                toggleExpanded={toggleExpanded}
                api={api}
              />
            )}
          </For>
        </Show>
      </Show>
      <Show when={telegramStatus() === "failed" || (telegramStatus() === "missing" && showTelegramWarning())}>
        <box marginTop={1}>
          <text fg="red" onMouseDown={() => openUrl("https://github.com/ykocaman/opencode-session-tracker/blob/main/docs/telegram-setup.md")}>
            ⚠️ Telegram integration failed
          </text>
        </box>
      </Show>
    </box>
  );
}

/** @jsxImportSource @opentui/solid */
import { createResource, onCleanup, For, Show, createSignal } from "solid-js";
import type { Plugin } from "@opencode/plugin/tui";
import { exec } from "child_process";
import { getTelegramStatus, updateCurrentSessionId, getArchivedSessions, archiveSession } from "../telegram";
import { currentRoute, localRunStatus, pendingForms, pendingPermissions, unwrapSessionList, workdir } from "../core/ctx";
import { getStatusSignal } from "./signals";
import { SessionItem } from "./SessionItem";
import { DAY_MS, groupByParent, isListableSession, updatedAt } from "../sessions";

type TuiContext = Plugin.Context;

let cachedSessions: any[] = [];
let cachedDir = '';

export function SessionSidebar(props: { sessionID?: string; ctx: TuiContext }) {
  const { ctx } = props;

  // Keep telegram in sync with the TUI's active session
  updateCurrentSessionId(props.sessionID || null);
  const [expanded, setExpanded] = createSignal<Set<string>>(new Set());
  const [currentSessionId, setCurrentSessionId] = createSignal<string | undefined>(props.sessionID);

  const initialStatus = getTelegramStatus();
  const [telegramStatus, setTelegramStatus] = createSignal<string>(initialStatus);
  const [showTelegramWarning, setShowTelegramWarning] = createSignal<boolean>(true);
  const [archived, setArchived] = createSignal<Set<string>>(getArchivedSessions());

  const handleArchive = (id: string) => {
    archiveSession(id);
    setArchived(getArchivedSessions());
  };

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
    const activeDir = workdir();
    if (activeDir !== cachedDir) {
      cachedSessions = [];
      cachedDir = activeDir;
    }
    try {
      const response = await ctx.client.session.list({ directory: activeDir, limit: 30 });
      const data = unwrapSessionList(response);
      if (data.length > 0) {
        cachedSessions = data;
      }
      return cachedSessions;
    } catch (err) {
      return cachedSessions;
    }
  };

  const activeDir = workdir();
  const initialSessions = activeDir === cachedDir ? cachedSessions : [];
  const [rawSessions, { refetch }] = createResource(fetchSessions, {
    initialValue: initialSessions
  });

  const interval = setInterval(() => {
    refetch();
    setArchived(getArchivedSessions());
    // Sync active session from route (slot sessionID may not be reactive)
    const route = currentRoute();
    if (route.type === "session" && route.sessionID) {
      setCurrentSessionId(route.sessionID);
    }
  }, 3000);
  onCleanup(() => clearInterval(interval));

  // Pending form/permission questions take precedence over the session's run status.
  const getApiStatusType = (sessionId: string): string => {
    if (pendingForms(sessionId).length > 0) return "ask";
    if (pendingPermissions(sessionId).length > 0) return "perm";
    const st = localRunStatus(sessionId);
    return st === "running" ? "busy" : st;
  };

  const displaySessions = () => {
      let sessions = rawSessions() || [];
      const now = Date.now();

      const archivedIds = archived();
      // 24 hours since last update (or manually archived) = expired
      const isExpired = (s: any) => archivedIds.has(s.id) || now - updatedAt(s) >= DAY_MS;

      sessions = sessions.filter((s: any) => isListableSession(s, now));

      sessions.sort((a: any, b: any) => (b.time?.updated || 0) - (a.time?.updated || 0));

      const parents = groupByParent(sessions);

      const isSessionActive = (session: any) => {
        const [status] = getStatusSignal(session.id);
        const st = status();
        return st !== "idle" && st !== "done" && st !== "error";
      };
      // Evaluate every session (no short-circuit) so each status signal gets tracked
      const hasActiveWork = (p: any) => {
        const flags = [p, ...(p.subagents || [])].map(isSessionActive);
        return flags.some(Boolean);
      };

      parents.sort((a: any, b: any) => {
          const aActive = hasActiveWork(a);
          const bActive = hasActiveWork(b);
          if (aActive !== bActive) return aActive ? -1 : 1;
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
              return status() !== "idle" || getApiStatusType(sub.id) !== "idle";
          });

          visibleSubs.forEach((sub: any, index: number) => {
              const isLast = index === visibleSubs.length - 1;
              list.push({ ...sub, isSubagent: true, isLastSubagent: isLast, isExpired: isExpired(p) });
          });
      });

      list.forEach((s: any) => {
        const [status, setStatus] = getStatusSignal(s.id);
        const next = getApiStatusType(s.id);
        // Reconcile toward/away from idle so a missed event can't wedge the
        // badge at RUN (or hide a missed busy); never override between
        // active states (preserves e.g. retry/ask set by events).
        if (status() !== next && (next === "idle" || status() === "idle")) setStatus(next);
      });

      return list;
  };

  const openUrl = (url: string) => {
    try {
      const start = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
      exec(`${start} ${url}`);
    } catch(e) {}
  };

  const goHome = () => {
    try {
      ctx.ui.router.navigate({ type: "home" });
    } catch (e) {}
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
        <text fg="magenta" onMouseDown={goHome}>[Home]</text>
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
            onArchive={handleArchive}
            ctx={ctx}
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
                ctx={ctx}
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

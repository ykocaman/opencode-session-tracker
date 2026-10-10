// Session list helpers shared by the TUI sidebar and the Telegram menus.

export const DAY_MS = 24 * 60 * 60 * 1000;
export const WEEK_MS = 7 * DAY_MS;

export const updatedAt = (s: any): number => typeof s.time?.updated === 'number' ? s.time.updated : 0;

/** Sessions worth listing: not deleted/archived, titled, and updated within the last week. */
export function isListableSession(s: any, now: number): boolean {
  return s.status !== "deleted" && !s.time?.archived && !!s.title && s.title.trim() !== "" && now - updatedAt(s) < WEEK_MS;
}

/** Top-level sessions (sub-agent sessions are attached to their ultimate parent as `subagents`). */
export function groupByParent(sessions: any[]): any[] {
  const byId = new Map<string, any>();
  sessions.forEach(s => {
    s.subagents = [];
    byId.set(s.id, s);
  });

  const findUltimateParent = (s: any) => {
    let current = s;
    let lastVisible = null;
    const visited = new Set();
    while (current.parentID && !visited.has(current.id)) {
      visited.add(current.id);
      const parent = byId.get(current.parentID);
      if (!parent) break;
      lastVisible = parent;
      current = parent;
    }
    return lastVisible;
  };

  const parents: any[] = [];
  sessions.forEach(s => {
    const p = findUltimateParent(s);
    if (p) p.subagents.push(s);
    else parents.push(s);
  });
  return parents;
}

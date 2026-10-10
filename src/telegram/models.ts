import { execFile } from 'child_process';
import util from 'util';
import os from 'os';
import path from 'path';
import { bot, apiRef } from '../core/runtime';
import { readState } from '../core/store';
import { modelIds, shortHash } from './keyboards';
import { getTargetDir, getActiveSessionId } from '../core/context';

const execFileAsync = util.promisify(execFile);

export interface ModelRef {
  providerID: string;
  modelID: string;
}

const FAVORITE_MODELS = ['openrouter/anthropic/claude-3.5-sonnet', 'gemini/gemini-2.5-pro', 'openrouter/google/gemini-2.5-pro'];
const KNOWN_PROVIDERS = ['openrouter', 'gemini', 'anthropic', 'vertex', 'openai', 'opencode', 'google'];

function modelName(m: any): string {
  const id = m.modelID || m.id || '';
  return m.providerID === 'openrouter' ? (id.split('/').pop() || id) : id;
}

function getModelPriority(providerID: string, modelID: string): number {
  const modelStr = `${providerID}/${modelID}`;
  const fav = FAVORITE_MODELS.indexOf(modelStr);
  if (fav !== -1) return 100 - fav;
  if (providerID === 'anthropic' && modelID.includes('claude-3-5-sonnet')) return 10;
  if (providerID === 'gemini' && modelID.includes('gemini-2.5-pro')) return 9;
  if (providerID === 'gemini' && modelID.includes('gemini-2.5-flash')) return 8;
  return 0;
}

/**
 * Splits "provider/model" ids into provider + model parts.
 * Legacy fallback only: live buttons carry the exact API pair in `modelIds`,
 * so this never runs for fresh menus. Never defaults to openrouter when the
 * id already carries a provider segment (that bug switched sessions to a
 * non-existent `openrouter/<...>` model).
 */
export function parseModelId(fullId: string): { providerID: string; modelID: string } {
  const hit = KNOWN_PROVIDERS
    .filter(p => fullId === p || fullId.startsWith(`${p}/`))
    .sort((a, b) => b.length - a.length)[0];
  if (hit) return { providerID: hit, modelID: fullId === hit ? '' : fullId.slice(hit.length + 1) };
  const i = fullId.indexOf('/');
  if (i > 0) return { providerID: fullId.slice(0, i), modelID: fullId.slice(i + 1) };
  return { providerID: 'openrouter', modelID: fullId };
}

/** Recently used models, newest first (from assistant message history). */
export async function recentModelRefs(limit = 30): Promise<ModelRef[]> {
  try {
    const dbPath = path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db');
    // Dedup in SQL: raw rows are MBs and blow up execFile's buffer.
    const { stdout } = await execFileAsync('sqlite3', ['-json', dbPath,
      `SELECT json_extract(data,'$.model.providerID') AS p, json_extract(data,'$.model.id') AS m, max(rowid) AS r ` +
      `FROM session_message WHERE m IS NOT NULL GROUP BY p, m ORDER BY r DESC LIMIT ${limit}`]);
    const rows = JSON.parse(stdout || '[]');
    const out: ModelRef[] = [];
    for (const r of rows) {
      if (r?.p && r?.m) out.push({ providerID: r.p, modelID: r.m });
    }
    return out;
  } catch {
    return [];
  }
}

export async function getModelsKeyboard(filter?: string) {
  const kb: any[][] = [];
  try {
    const modelsRes = await apiRef.client.model.list({});
    let models = modelsRes?.data || modelsRes || [];
    if (!Array.isArray(models)) models = [];

    const f = (filter || '').trim().toLowerCase();
    const modelIdOf = (m: any) => m.modelID || m.id || '';
    if (f) {
      models = models.filter((m: any) => `${m.providerID || ''}/${modelIdOf(m)}`.toLowerCase().includes(f));
    }

    // Recency first (opencode TUI "recents" behaviour), then favorites, then A-Z.
    const recent = await recentModelRefs();
    const rank = new Map(recent.map((r, i) => [`${r.providerID}/${r.modelID}`, i]));
    models.sort((a: any, b: any) => {
      const ra = rank.get(`${a.providerID}/${modelIdOf(a)}`) ?? Number.MAX_SAFE_INTEGER;
      const rb = rank.get(`${b.providerID}/${modelIdOf(b)}`) ?? Number.MAX_SAFE_INTEGER;
      if (ra !== rb) return ra - rb;
      const priA = getModelPriority(a.providerID, modelIdOf(a));
      const priB = getModelPriority(b.providerID, modelIdOf(b));
      return priA !== priB ? priB - priA : modelIdOf(a).localeCompare(modelIdOf(b));
    });

    const currentActive = getActiveSessionId(getTargetDir());
    const current = currentActive ? readState().sessionModels?.[currentActive] : null;

    models.slice(0, 10).forEach((m: any) => {
      const mid = modelIdOf(m);
      const isSelected = !!current && mid === current.modelID && m.providerID === current.providerID;
      const full = `${m.providerID}/${mid}`;
      const shortId = shortHash(full);
      // Exact API pair — the callback uses it verbatim, no provider guessing.
      modelIds.set(shortId, { providerID: m.providerID, modelID: mid });
      kb.push([{ text: `${isSelected ? '→ ' : ''}${modelName(m)}`, callback_data: `model_select_${shortId}` }]);
    });
  } catch (e) {}
  return kb;
}

export async function handleModelsCommand(chatId: number, filter?: string) {
  try {
    const kb = await getModelsKeyboard(filter);
    if (kb.length === 0) {
      bot?.sendMessage(chatId, `No models match "${filter}".`).catch(() => {});
      return;
    }
    bot?.sendMessage(chatId, '🤖 <b>Models</b>\n<i>/models &lt;text&gt; to filter</i>', {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: kb },
    });
  } catch (err) {
    bot?.sendMessage(chatId, '❌ Failed to list models.').catch(() => {});
  }
}

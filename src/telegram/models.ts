import { bot, apiRef, readState } from './state';
import { modelIds, shortHash } from './keyboards';
import { getTargetDir, getActiveSessionId } from './stores';

const FAVORITE_MODELS = ['openrouter/anthropic/claude-3.5-sonnet', 'gemini/gemini-2.5-pro', 'openrouter/google/gemini-2.5-pro'];
const KNOWN_PROVIDERS = ['openrouter', 'gemini', 'anthropic', 'vertex', 'openai'];

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

/** Splits "provider/model" ids coming from the keyboard into provider + model parts. */
export function parseModelId(fullId: string): { providerID: string; modelID: string } {
  const providerID = KNOWN_PROVIDERS.find(p => p !== 'openrouter' && fullId.includes(`${p}/`)) || 'openrouter';
  const modelID = fullId.replace(new RegExp(`^(${KNOWN_PROVIDERS.join('|')})/`), '');
  return { providerID, modelID };
}

export async function getModelsKeyboard() {
  const kb: any[][] = [];
  try {
    const modelsRes = await apiRef.client.model.list({});
    let models = modelsRes?.data || modelsRes || [];
    if (!Array.isArray(models)) models = [];

    const modelIdOf = (m: any) => m.modelID || m.id || '';
    models.sort((a: any, b: any) => {
      const priA = getModelPriority(a.providerID, modelIdOf(a));
      const priB = getModelPriority(b.providerID, modelIdOf(b));
      return priA !== priB ? priB - priA : modelIdOf(a).localeCompare(modelIdOf(b));
    });

    const currentActive = getActiveSessionId(getTargetDir());
    const current = currentActive ? readState().sessionModels?.[currentActive] : null;

    models.slice(0, 10).forEach((m: any) => {
      const mid = modelIdOf(m);
      const isSelected = !!current && mid === current.modelID && m.providerID === current.providerID;
      const cleanId = `${m.providerID}/${mid}`;
      const shortId = shortHash(cleanId);
      modelIds.set(shortId, cleanId);
      kb.push([{ text: `${isSelected ? '→ ' : ''}${modelName(m)}`, callback_data: `model_select_${shortId}` }]);
    });
  } catch (e) {}
  return kb;
}

export async function handleModelsCommand(chatId: number) {
  try {
    const kb = await getModelsKeyboard();
    bot?.sendMessage(chatId, '🤖 <b>Models</b>', {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: kb },
    });
  } catch (err) {
    bot?.sendMessage(chatId, '❌ Failed to list models.').catch(() => {});
  }
}

import { bot, apiRef, allowedUsers } from '../core/runtime';
import { pendingForms } from '../core/ctx';

// v2 question flow: one Telegram prompt per form field. Answers are collected
// by field key and submitted via session.form.reply once every field is
// answered (or cancelled via session.form.cancel).
export interface QuestionFlow {
  requestId: string; // form id
  sessionId: string;
  questions: any[]; // adapted fields: { key, question, options?: [{ value, label }], userAnswer }
  currentIndex: number;
  messageId?: number;
  chatId?: number;
  title: string;
}

import { qfMap, pendingQuestions } from '../core/context';

const questionCounter = (flow: QuestionFlow, index: number) =>
  flow.questions.length > 1 ? ` (${index}/${flow.questions.length})` : '';

const CLEAR_KEYBOARD = { inline_keyboard: [] };

function closeFlowMessage(flow: QuestionFlow, text: string, extra: object = {}) {
  if (!flow.chatId || !flow.messageId) return;
  bot?.editMessageText(text, {
    chat_id: flow.chatId,
    message_id: flow.messageId,
    reply_markup: CLEAR_KEYBOARD,
    ...extra,
  }).catch(() => {});
}

function adaptField(f: any) {
  const question = [f?.title, f?.description].filter(Boolean).join('\n') || 'Input required';
  const options = Array.isArray(f?.options)
    ? f.options.map((o: any) => typeof o === 'string'
        ? { value: o, label: o }
        : { value: o.value, label: o.label || o.value })
    : undefined;
  return { key: f?.key || `field_${Math.random().toString(36).slice(2, 8)}`, question, options, userAnswer: f?.default };
}

export function notifyTelegramQuestion(formId: string, sessionId: string, fields: any[], title: string) {
  const questions = (Array.isArray(fields) ? fields : []).map(adaptField).filter(q => q.key);
  if (questions.length === 0) return;
  const flow: QuestionFlow = { requestId: formId, sessionId, questions, currentIndex: 0, title };
  qfMap.set(formId, flow);
  sendQuestionMessage(flow);
}

export function sendQuestionMessage(flow: QuestionFlow) {
  const q = flow.questions[flow.currentIndex];
  const inlineKeyboard: any[][] = [];

  if (Array.isArray(q.options)) {
    q.options.forEach((opt: any) => {
      const label = String(opt.label ?? opt.value ?? '');
      const value = String(opt.value ?? opt.label ?? '');
      if (label) inlineKeyboard.push([{ text: label.slice(0, 64), callback_data: `q_ans_${value.slice(0, 30)}` }]);
    });
  }
  inlineKeyboard.push([{ text: '❌ Skip/Cancel', callback_data: 'q_cancel' }]);

  // Plain text — no parse_mode to avoid Markdown entity parse errors
  const msg = `📌 ${flow.title}${questionCounter(flow, flow.currentIndex + 1)}\n\n${q.question}`;

  // Send to all allowed users and persist messageId/chatId back to disk
  allowedUsers.forEach(async (userId) => {
    try {
      const sent = await bot?.sendMessage(userId, msg, { reply_markup: { inline_keyboard: inlineKeyboard } });
      if (sent) {
        flow.messageId = sent.message_id;
        flow.chatId = sent.chat.id;
        qfMap.set(flow.requestId, flow);
      }
    } catch (e) { console.error('[Telegram] sendQuestionMessage error:', e); }
  });
}

/** Record an answer for the current field; sends the next one or submits the flow. */
export function answerQuestionFlow(flow: QuestionFlow, answer: string) {
  flow.questions[flow.currentIndex].userAnswer = answer;
  flow.currentIndex++;
  qfMap.set(flow.requestId, flow); // persist progress

  if (flow.currentIndex < flow.questions.length) {
    sendQuestionMessage(flow);
  } else {
    submitQuestionFlow(flow);
  }
}

/** Answer the flow's current field with free text (used by cross-instance sync). */
export function answerFlowWithText(sessionId: string, formId: string, text: string): boolean {
  const flow = qfMap.get(formId);
  if (flow && flow.sessionId === sessionId) {
    answerQuestionFlow(flow, text);
    return true;
  }
  // No local flow (e.g. after restart): reply directly when the form has a single field.
  try {
    const forms = apiRef?.data?.session?.form?.list?.(sessionId) || [];
    const form = forms.find((f: any) => f.id === formId);
    const fields = form?.fields || [];
    if (form && fields.length === 1 && fields[0]?.key) {
      apiRef.client.session.form.reply({
        sessionID: sessionId,
        formID: formId,
        answer: { [fields[0].key]: text },
      }).catch(() => {});
      return true;
    }
  } catch (e) {}
  return false;
}

function submitQuestionFlow(flow: QuestionFlow) {
  try {
    const lastAnswer = flow.questions[flow.currentIndex - 1]?.userAnswer || '';
    const answer: Record<string, any> = {};
    for (const q of flow.questions) {
      if (q.key) answer[q.key] = q.userAnswer ?? '';
    }
    apiRef.client.session.form.reply({
      sessionID: flow.sessionId,
      formID: flow.requestId,
      answer,
    }).catch(() => {});

    const q = flow.questions[flow.questions.length - 1];
    closeFlowMessage(flow, `✅ ${flow.title}${questionCounter(flow, flow.questions.length)}\n\n${q.question}\n\nAnswered: ${lastAnswer}`);
  } catch (e) {}
  qfMap.delete(flow.requestId);
}

export function cancelQuestionFlow(flow: QuestionFlow) {
  try {
    apiRef.client.session.form.cancel({
      sessionID: flow.sessionId,
      formID: flow.requestId,
    }).catch(() => {});

    const q = flow.questions[flow.currentIndex];
    closeFlowMessage(
      flow,
      `— *${flow.title}*${questionCounter(flow, flow.currentIndex + 1)}\n\n${q.question}\n\n_Cancelled_`,
      { parse_mode: 'Markdown' },
    );
  } catch (e) {}
  qfMap.delete(flow.requestId);
}

/** Close the Telegram message of a flow that was answered/cancelled in the terminal. */
export function closeFlowAnsweredInTerminal(flow: QuestionFlow) {
  const q = flow.questions[flow.currentIndex] || flow.questions[flow.questions.length - 1];
  closeFlowMessage(flow, `— ${flow.title}${questionCounter(flow, flow.questions.length)}\n\n${q.question}\n\n_Answered in terminal_`);
}

export function findFlow(predicate: (flow: QuestionFlow) => boolean): QuestionFlow | null {
  return qfMap.values().find(predicate) || null;
}

/**
 * Leader duty: flows answered/cancelled in the terminal no longer appear in
 * the session's pending forms — close their Telegram messages so the user
 * isn't left staring at dead buttons.
 */
export function closeExternallyAnsweredQuestions() {
  for (const flow of qfMap.values()) {
    try {
      if (!flow.chatId || !flow.messageId) continue;
      const pending = pendingForms(flow.sessionId);
      if (pending.some((f: any) => f?.id === flow.requestId)) continue;
      closeFlowAnsweredInTerminal(flow);
      qfMap.delete(flow.requestId);
      pendingQuestions.delete(flow.sessionId);
    } catch {}
  }
}

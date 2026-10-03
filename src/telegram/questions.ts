import { bot, apiRef, allowedUsers } from './state';
import { QuestionFlow, qfMap } from './stores';

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

export function notifyTelegramQuestion(requestId: string, sessionId: string, questions: any[], title: string, isV2 = false) {
  const flow: QuestionFlow = { requestId, sessionId, questions, currentIndex: 0, title, isV2 };
  qfMap.set(requestId, flow);
  sendQuestionMessage(flow);
}

export function sendQuestionMessage(flow: QuestionFlow) {
  const q = flow.questions[flow.currentIndex];
  const inlineKeyboard: any[][] = [];

  if (Array.isArray(q.options)) {
    q.options.forEach((opt: any, idx: number) => {
      // QuestionOption = { label: string, description: string }
      const label = typeof opt === 'string' ? opt : (opt.label || opt.text || String(idx + 1));
      inlineKeyboard.push([{ text: label.slice(0, 64), callback_data: `q_ans_${label.slice(0, 30)}` }]);
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

/** Record an answer for the current question; sends the next one or submits the flow. */
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

function submitQuestionFlow(flow: QuestionFlow) {
  try {
    const lastAnswer = flow.questions[flow.currentIndex - 1]?.userAnswer || '';
    // QuestionAnswer = Array<string>, answers = Array<QuestionAnswer>
    const replyArgs = {
      requestID: flow.requestId,
      answers: flow.questions.map((q: any) => [q.userAnswer || '']),
    };
    if (flow.isV2) {
      // OpenCode >=1.18: use questionV2 API
      (apiRef.client as any).questionV2?.reply(replyArgs).catch(() => {});
    } else {
      apiRef.client.question.reply(replyArgs).catch(() => {});
    }

    const q = flow.questions[flow.questions.length - 1];
    closeFlowMessage(flow, `✅ ${flow.title}${questionCounter(flow, flow.questions.length)}\n\n${q.question}\n\nAnswered: ${lastAnswer}`);
  } catch (e) {}
  qfMap.delete(flow.requestId);
}

export function cancelQuestionFlow(flow: QuestionFlow) {
  try {
    apiRef.client.question.reply({
      requestID: flow.requestId,
      answers: flow.questions.map(() => ['']),
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

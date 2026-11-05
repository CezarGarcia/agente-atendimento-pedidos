/**
 * Interpretação DETERMINÍSTICA da resposta do cliente a um pedido de confirmação (regra 4).
 *
 * O modelo de IA não participa desta decisão. Só contam como confirmação um botão com o id da
 * ação pendente ou uma resposta curta e inequívoca ("sim", "pode cancelar"). Qualquer outra
 * coisa ("acho que sim, mas...", "sim, mas é o outro pedido") é tratada como não confirmada e o
 * agente pergunta de novo. Em uma ação irreversível, é melhor perguntar duas vezes do que
 * cancelar errado.
 */

export type ConfirmationDecision = 'confirm' | 'decline' | 'unclear';

export const CONFIRM_PAYLOAD_PREFIX = 'CONFIRM_CANCEL:';
export const DECLINE_PAYLOAD_PREFIX = 'KEEP_ORDER:';

const CONFIRMATIONS = new Set([
  'sim',
  's',
  'ss',
  'sim sim',
  'sim pode',
  'pode',
  'pode sim',
  'pode cancelar',
  'sim pode cancelar',
  'sim cancela',
  'sim cancelar',
  'sim cancele',
  'cancela',
  'cancelar',
  'cancele',
  'pode cancelar sim',
  'confirmo',
  'confirmar',
  'confirmado',
  'sim confirmo',
  'sim quero',
  'quero sim',
  'quero cancelar',
  'sim quero cancelar',
  'isso',
  'isso mesmo',
  'sim por favor',
  'sim pf',
  'sim obrigado',
  'sim obrigada',
  'claro',
  'com certeza',
  'yes',
]);

const DECLINES = new Set([
  'nao',
  'n',
  'nn',
  'nao quero',
  'nao cancela',
  'nao cancele',
  'nao cancelar',
  'nao pode',
  'nao obrigado',
  'nao obrigada',
  'cancela nao',
  'deixa',
  'deixa pra la',
  'deixa quieto',
  'desisto',
  'desisti',
  'mudei de ideia',
  'manter',
  'manter pedido',
  'manter o pedido',
  'quero manter',
  'pode manter',
  'melhor nao',
  'no',
]);

/** Minúsculas, sem acentos, sem pontuação/emojis e com espaços normalizados. */
export function normalizeReply(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function interpretConfirmation(
  pendingActionId: string,
  reply: { text?: string | undefined; buttonPayload?: string | undefined },
): ConfirmationDecision {
  if (reply.buttonPayload !== undefined) {
    if (reply.buttonPayload === `${CONFIRM_PAYLOAD_PREFIX}${pendingActionId}`) return 'confirm';
    if (reply.buttonPayload === `${DECLINE_PAYLOAD_PREFIX}${pendingActionId}`) return 'decline';
    // Botão de uma confirmação antiga (já expirada ou substituída): não vale para a atual.
    return 'unclear';
  }

  const normalized = normalizeReply(reply.text ?? '');
  if (CONFIRMATIONS.has(normalized)) return 'confirm';
  if (DECLINES.has(normalized)) return 'decline';
  return 'unclear';
}

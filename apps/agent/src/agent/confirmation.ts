/**
 * Interpretação DETERMINÍSTICA da resposta do cliente a um pedido de confirmação (regra 4).
 *
 * O modelo de IA não participa desta decisão. Só contam como confirmação:
 *  - o botão com o id da ação pendente (inequívoco: diz a QUAL pergunta o cliente respondeu);
 *  - uma resposta curta e inequívoca ("sim", "pode cancelar"), e somente se a última mensagem
 *    enviada ao cliente foi a própria pergunta de confirmação. Depois de qualquer outra resposta
 *    do agente, um "sim" pode estar respondendo outra coisa (ex.: "quer falar com um atendente?").
 * Qualquer outra coisa ("acho que sim, mas...", "pode?") é tratada como não confirmada. Em uma
 * ação irreversível, é melhor perguntar duas vezes do que cancelar errado.
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

/** Emojis de aprovação aceitos junto do "sim" (com ou sem modificador de tom de pele). */
const APPROVAL_EMOJI = /👍|✅|👌|🙂|😊|😀|😃|🙏|☺|❤/gu;
const SKIN_TONE_AND_VARIATION = /[\u{1F3FB}-\u{1F3FF}]|\u{FE0F}/gu;

/** O que sobra sem letras, números, espaços e emojis de aprovação é só ".", "!" ou ","? */
function hasOnlyPlainPunctuation(text: string): boolean {
  const rest = text
    .normalize('NFKC')
    .replace(/[\p{L}\p{N}\s]/gu, '')
    .replace(APPROVAL_EMOJI, '')
    .replace(SKIN_TONE_AND_VARIATION, '');
  return /^[.!,]*$/.test(rest) && !/\.{2,}/.test(rest);
}

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
  options: { acceptText: boolean },
): ConfirmationDecision {
  if (reply.buttonPayload !== undefined) {
    if (reply.buttonPayload === `${CONFIRM_PAYLOAD_PREFIX}${pendingActionId}`) return 'confirm';
    if (reply.buttonPayload === `${DECLINE_PAYLOAD_PREFIX}${pendingActionId}`) return 'decline';
    // Botão de uma confirmação antiga (já expirada ou substituída): não vale para a atual.
    return 'unclear';
  }

  const text = reply.text ?? '';
  // Texto só vale logo após a pergunta, e só se o que sobra além das palavras for pontuação simples
  // ou um emoji de aprovação. Pergunta em qualquer alfabeto ("sim？", "sim¿", "sim❓"), dúvida ou
  // recusa em emoji ("sim 🤔", "sim 👎"), reticências ("sim…") e citação ("\"sim\"") não confirmam.
  if (!options.acceptText || !hasOnlyPlainPunctuation(text)) return 'unclear';
  const normalized = normalizeReply(text);
  if (CONFIRMATIONS.has(normalized)) return 'confirm';
  if (DECLINES.has(normalized)) return 'decline';
  return 'unclear';
}

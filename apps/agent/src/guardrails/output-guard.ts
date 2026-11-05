import { redactPii } from '@agente/shared';

import { shingles } from '../agent/prompt.js';

/**
 * Guardrail de saída: confere a resposta do modelo ANTES de enviá-la ao cliente.
 *
 * O ponto central é a regra 5 ("só informar que cancelou se a API retornou sucesso"):
 * qualquer afirmação de cancelamento só passa se a API principal confirmou, nesta conversa, que
 * aquele pedido está cancelado. A lista de padrões é deliberadamente ampla: um falso positivo
 * custa uma resposta genérica; um falso negativo custa uma informação errada ao cliente.
 */

export interface OutputGuardContext {
  /** Pedidos que a API principal mostrou cancelados nesta conversa (consulta ou cancelamento). */
  readonly verifiedCancelledOrderIds: ReadonlySet<string>;
  /**
   * Pedidos consultados um a um neste turno (consultar_pedido ou solicitar_cancelamento) que a API
   * mostrou cancelados. Uma afirmação sem número só passa se houver exatamente um: uma lista de
   * pedidos não diz a qual deles a frase se refere.
   */
  readonly verifiedThisTurn: ReadonlySet<string>;
  readonly handoffCreated: boolean;
  /** Marcador secreto presente no prompt: se aparecer na resposta, houve vazamento. */
  readonly canary: string;
  /** Sequências de 8 palavras das instruções (sem os exemplos). */
  readonly promptFingerprint?: ReadonlySet<string>;
}

export type OutputGuardReason =
  | 'empty'
  | 'prompt_leak'
  | 'unverified_cancellation_claim'
  | 'unverified_handoff_claim'
  | 'refund_promise'
  | 'pii_redacted'
  | 'link_removed'
  | 'too_long';

export interface OutputGuardResult {
  readonly action: 'pass' | 'modified' | 'blocked';
  readonly text: string;
  readonly reasons: readonly OutputGuardReason[];
}

export const MAX_OUTPUT_LENGTH = 1_000;

/**
 * Janelas de 8 palavras das instruções que precisam aparecer na resposta para caracterizar
 * vazamento. Vazar instruções reproduz trechos longos (várias janelas); uma única coincidência de
 * 8 palavras costuma ser o modelo usando uma expressão que as próprias instruções sugerem (visto
 * nos evals: "use o botão Sim, cancelar da mensagem anterior").
 */
const MIN_PROMPT_SHINGLES = 2;

const INTERNAL_MARKERS = [
  'regras_de_negocio',
  'protocolo_de_cancelamento',
  'contexto_da_sessao',
  'uso_das_ferramentas',
  'seguranca_e_limites',
  'estilo_de_comunicacao',
  'aviso_do_sistema',
];

/** Qualquer menção a algo "cancelado"/"cancelamento concluído" é tratada como afirmação. */
const CANCELLATION_CLAIMS = [
  /\b(cancelad|anulad)[oa]s?\b/g,
  /\b(cancelei|cancelamos|anulei|anulamos)\b/g,
  /\bcancelamento\b[^.!?\n]{0,40}\b(realizado|concluido|efetuado|confirmado|feito|aprovado|processado|finalizado|deu certo|com sucesso)\b/g,
  /\b(was|were|has been|have been|is|are|got)\s+(successfully\s+)?cancell?ed\b/g,
  /\bcancell?ed\s+successfully\b/g,
  /\bcancell?ation\b[^.!?\n]{0,40}\b(successful|complete|completed|confirmed|done|went through)\b/g,
];

/**
 * Consequências que só um cancelamento produz ("não será mais enviado"). Em frase condicional
 * ("se confirmar, o pedido não será mais enviado") explicam o efeito, não afirmam o fato.
 */
const CANCELLATION_CONSEQUENCES = [
  /\bnao (sera|vai ser) mais (enviad[oa]s?|entregues?|despachad[oa]s?)\b/g,
  /\bnao vai mais (ser (enviad[oa]s?|entregues?|despachad[oa]s?)|chegar)\b/g,
  /\b(will no longer|won't) be (shipped|delivered)\b/g,
];
const CONDITIONAL =
  /\b(se|caso|quando|apos|depois que|assim que|ao (cancelar|confirmar)|com o cancelamento|if|once|after)\b/;

const HANDOFF_CLAIMS = [
  /\b(transferi|encaminhei)\b/g,
  /\b(foi|esta sendo|ja foi|ficou)\s+(transferid|encaminhad)[oa]\b/g,
  /\bprotocolo\s+atd\s?\d+/g,
];

/** Promessas sobre devolução de dinheiro: o agente não tem acesso nem autonomia sobre isso. */
const REFUND_PROMISE =
  /\b(estorno|reembolso|devolucao do (valor|dinheiro)|dinheiro de volta)\b[^.!?\n]{0,60}\b(cai|caira|sera (creditad|devolvid|feit|realizad|estornad|processad)|(ja )?foi (realizad|efetuad|feit|creditad|aprovad|processad|estornad)|em ate \d+|em \d+\s*(dias?|horas?)|\d+\s*dias? uteis|garantid|imediat|automaticamente)/;

/*
 * O alcance da negação e da hipótese não atravessa pontuação: em "Não se preocupe, foi cancelado"
 * e "Pra constar: foi cancelado" a afirmação está fora do alcance e precisa ser verificada.
 */
const WORD = String.raw`\s+[^\s,;:!?.]+`;
/** Negação logo antes ("não foi cancelado", "nada foi cancelado", "nenhum pedido foi cancelado"). */
const NEGATION_BEFORE = new RegExp(
  String.raw`\b(nao|nem|nunca|jamais|nada|nenhum|nenhuma|not|never|nothing)\b(${WORD}){0,3}\s*$`,
);
/** "Não posso dizer que foi cancelado": a afirmação é negada pelo verbo que a introduz. */
const NEGATED_REPORT_BEFORE = new RegExp(
  String.raw`\b(nao|nem|nunca)\s+(posso|consigo|vou|devo|podemos|conseguimos|da para|da pra|tenho como)\s+(dizer|afirmar|confirmar|informar|garantir|escrever|responder)\s+que(${WORD}){0,3}\s*$`,
);
/** Futuro/hipótese ("será cancelado", "pode ser cancelado", "para ser cancelado"). */
const HYPOTHETICAL_BEFORE = new RegExp(
  String.raw`\b(sera|seja|for|fosse|seria|caso|se|quer|deseja|gostaria|para|pra|(pode|podem|possa|poderia|vai|vao|deve|devem|precisa|consigo|posso)\s+(ser|ficar)|will be|would be|can be|to be)\b(${WORD}){0,2}\s*$`,
);
/**
 * Negação ou modalidade DENTRO do trecho casado ("o cancelamento não pode ser feito", "o
 * cancelamento ainda não foi concluído", "the cancellation could not be completed").
 */
const NEGATION_INSIDE =
  /\b(nao|nem|nunca|not|never|cannot)\b|\b(pode|podem|possa|poderia|precisa|deve|vai|sera|seria)\s+(ser|ficar|estar)\b|\b(can|could|will|would) be\b/;

const URL_PATTERN = /\b(?:https?:\/\/|www\.)\S+/gi;

function normalize(text: string): string {
  return text.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/-/g, ' ');
}

const precededBy = (text: string, index: number, pattern: RegExp): boolean =>
  pattern.test(text.slice(Math.max(0, index - 45), index));

/**
 * Ocorrências afirmativas: nem negadas nem em tom de futuro/hipótese. `checkInside` vale para
 * padrões que casam um trecho ("cancelamento … feito"), não para os que já contêm a negação
 * como parte da afirmação ("não será mais enviado").
 */
function affirmativeMatches(
  text: string,
  patterns: readonly RegExp[],
  { checkInside = false } = {},
): RegExpMatchArray[] {
  return patterns.flatMap((pattern) =>
    [...text.matchAll(pattern)].filter(
      (match) =>
        !precededBy(text, match.index, NEGATION_BEFORE) &&
        !precededBy(text, match.index, NEGATED_REPORT_BEFORE) &&
        !precededBy(text, match.index, HYPOTHETICAL_BEFORE) &&
        !(checkInside && NEGATION_INSIDE.test(match[0])),
    ),
  );
}

const ORDER_ID = /\b\d{6}\b/g;

const SENTENCE_SEPARATORS = ['.', '!', '?', '\n', ';'];

function sentenceAround(text: string, index: number): { start: number; end: number } {
  const start = Math.max(...SENTENCE_SEPARATORS.map((sep) => text.lastIndexOf(sep, index))) + 1;
  const ends = SENTENCE_SEPARATORS.map((sep) => text.indexOf(sep, index)).filter((i) => i >= 0);
  return { start, end: ends.length > 0 ? Math.min(...ends) : text.length };
}

/**
 * Pedidos a que uma afirmação se refere, na mesma frase. Antes da afirmação: no singular, o número
 * mais próximo ("o 100201 (em processamento) e o 100202 (cancelado)" → 100202); no plural, todos
 * ("100101 e 100201 foram cancelados"). Sem número antes, os que vêm depois ("cancelei o 100101").
 */
function ordersReferencedBy(text: string, match: RegExpMatchArray): string[] {
  const index = match.index ?? 0;
  const { start, end } = sentenceAround(text, index);
  const before = text.slice(start, index).match(ORDER_ID) ?? [];
  if (before.length > 0) return match[0].endsWith('s') ? before : before.slice(-1);
  return text.slice(index, end).match(ORDER_ID) ?? [];
}

function cancellationClaimsAreVerified(text: string, context: OutputGuardContext): boolean {
  const consequences = affirmativeMatches(text, CANCELLATION_CONSEQUENCES).filter((match) => {
    const { start, end } = sentenceAround(text, match.index ?? 0);
    return !CONDITIONAL.test(text.slice(start, end));
  });
  const claims = affirmativeMatches(text, CANCELLATION_CLAIMS, { checkInside: true });
  return [...claims, ...consequences].every((match) => {
    const referenced = ordersReferencedBy(text, match);
    // O modelo nunca executa um cancelamento: uma afirmação sem número só pode se referir a um
    // pedido que ele acabou de consultar individualmente e que a API mostrou cancelado.
    if (referenced.length === 0) return context.verifiedThisTurn.size === 1;
    return referenced.every((id) => context.verifiedCancelledOrderIds.has(id));
  });
}

function hasRefundPromise(text: string): boolean {
  return text
    .split(/[.!?\n]+/)
    .some((sentence) => !/\b(nao|nem|nunca)\b/.test(sentence) && REFUND_PROMISE.test(sentence));
}

/** Ajustes de formato para mensagens de texto (WhatsApp/SMS). */
function normalizeFormat(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function truncate(text: string): string {
  if (text.length <= MAX_OUTPUT_LENGTH) return text;
  const cut = text.slice(0, MAX_OUTPUT_LENGTH);
  const lastSentence = Math.max(
    cut.lastIndexOf('. '),
    cut.lastIndexOf('? '),
    cut.lastIndexOf('! '),
  );
  return lastSentence > MAX_OUTPUT_LENGTH / 2
    ? cut.slice(0, lastSentence + 1)
    : `${cut.trimEnd()}…`;
}

export function guardOutput(raw: string, context: OutputGuardContext): OutputGuardResult {
  const blocked = (reason: OutputGuardReason): OutputGuardResult => ({
    action: 'blocked',
    text: '',
    reasons: [reason],
  });

  const formatted = normalizeFormat(raw);
  if (formatted === '') return blocked('empty');

  const normalized = normalize(formatted);
  const promptShingles = [...shingles(formatted)].filter((shingle) =>
    context.promptFingerprint?.has(shingle),
  );
  const reproducesPrompt = promptShingles.length >= MIN_PROMPT_SHINGLES;
  if (
    reproducesPrompt ||
    formatted.includes(context.canary) ||
    INTERNAL_MARKERS.some((marker) => normalized.includes(marker))
  ) {
    return blocked('prompt_leak');
  }
  if (!cancellationClaimsAreVerified(normalized, context)) {
    return blocked('unverified_cancellation_claim');
  }
  if (!context.handoffCreated && affirmativeMatches(normalized, HANDOFF_CLAIMS).length > 0) {
    return blocked('unverified_handoff_claim');
  }
  if (hasRefundPromise(normalized)) return blocked('refund_promise');

  const reasons: OutputGuardReason[] = [];
  // O agente não envia links: um link na resposta só pode ter vindo de dado externo (phishing).
  const withoutLinks = formatted.replace(URL_PATTERN, '[link removido]');
  if (withoutLinks !== formatted) reasons.push('link_removed');
  const pii = redactPii(withoutLinks);
  if (pii.detected.length > 0) reasons.push('pii_redacted');
  const text = truncate(pii.text);
  if (text !== pii.text) reasons.push('too_long');

  return { action: reasons.length > 0 ? 'modified' : 'pass', text, reasons };
}

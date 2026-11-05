import { redactPii } from '@agente/shared';

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
  /** Subconjunto verificado no turno atual (aceita afirmações que não citam o número). */
  readonly verifiedThisTurn: ReadonlySet<string>;
  readonly handoffCreated: boolean;
  /** Marcador secreto presente no prompt: se aparecer na resposta, houve vazamento. */
  readonly canary: string;
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
  /\bcancelad[oa]s?\b/g,
  /\bcancelei\b/g,
  /\bcancelamento\b[^.!?\n]{0,40}\b(realizado|concluido|efetuado|confirmado|feito|aprovado|processado|finalizado)\b/g,
  /\b(was|has been|have been|is|are|got)\s+(successfully\s+)?cancell?ed\b/g,
  /\bcancell?ed\s+successfully\b/g,
];

const HANDOFF_CLAIMS = [
  /\b(transferi|encaminhei)\b/g,
  /\b(foi|esta sendo|ja foi|ficou)\s+(transferid|encaminhad)[oa]\b/g,
  /\bprotocolo\s+atd\s?\d+/g,
];

/** Promessas sobre devolução de dinheiro: o agente não tem acesso nem autonomia sobre isso. */
const REFUND_PROMISE =
  /\b(estorno|reembolso|devolucao do (valor|dinheiro)|dinheiro de volta)\b[^.!?\n]{0,60}\b(cai|caira|sera (creditad|devolvid|feit|realizad|estornad|processad)|(ja )?foi (realizad|efetuad|feit|creditad|aprovad|processad|estornad)|em ate \d+|em \d+\s*(dias?|horas?)|\d+\s*dias? uteis|garantid|imediat|automaticamente)/;

/** Negação logo antes da afirmação ("não foi cancelado", "ainda não está cancelado"). */
const NEGATION_BEFORE = /\b(nao|nem|nunca|jamais|not|never)\b(\s+\S+){0,3}\s*$/;
/** Futuro/hipótese ("será cancelado", "pode ser cancelado", "para ser cancelado"). */
const HYPOTHETICAL_BEFORE =
  /\b(sera|seja|for|fosse|seria|caso|se|quer|deseja|gostaria|para|pra|(pode|possa|poderia|vai|deve|precisa|consigo|posso)\s+(ser|ficar)|will be|would be|can be|to be)\b(\s+\S+){0,2}\s*$/;

const URL_PATTERN = /\b(?:https?:\/\/|www\.)\S+/gi;

function normalize(text: string): string {
  return text.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/-/g, ' ');
}

const precededBy = (text: string, index: number, pattern: RegExp): boolean =>
  pattern.test(text.slice(Math.max(0, index - 45), index));

/** Ocorrências afirmativas: nem negadas nem em tom de futuro/hipótese. */
function affirmativeMatches(text: string, patterns: readonly RegExp[]): RegExpMatchArray[] {
  return patterns.flatMap((pattern) =>
    [...text.matchAll(pattern)].filter(
      (match) =>
        !precededBy(text, match.index, NEGATION_BEFORE) &&
        !precededBy(text, match.index, HYPOTHETICAL_BEFORE),
    ),
  );
}

const ORDER_ID = /\b\d{6}\b/g;

/**
 * Pedidos a que uma afirmação se refere: os números na mesma frase, antes da afirmação
 * ("o pedido 100202 está cancelado e o 100101 segue…" → só 100202); se não houver, os que vêm
 * depois na frase ("cancelei o pedido 100101").
 */
function ordersReferencedBy(text: string, index: number): string[] {
  const start =
    Math.max(...['.', '!', '?', '\n', ';'].map((sep) => text.lastIndexOf(sep, index))) + 1;
  const ends = ['.', '!', '?', '\n', ';']
    .map((sep) => text.indexOf(sep, index))
    .filter((i) => i >= 0);
  const end = ends.length > 0 ? Math.min(...ends) : text.length;
  const before = text.slice(start, index).match(ORDER_ID) ?? [];
  return before.length > 0 ? before : (text.slice(index, end).match(ORDER_ID) ?? []);
}

function cancellationClaimsAreVerified(text: string, context: OutputGuardContext): boolean {
  return affirmativeMatches(text, CANCELLATION_CLAIMS).every((match) => {
    const referenced = ordersReferencedBy(text, match.index ?? 0);
    // Sem número citado, só aceitamos se a confirmação da API aconteceu neste mesmo turno.
    if (referenced.length === 0) return context.verifiedThisTurn.size > 0;
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
  if (
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

import { redactPii } from '@agente/shared';

/**
 * Guardrail de saída: confere a resposta do modelo ANTES de enviá-la ao cliente.
 *
 * O ponto central é a regra 5 ("só informar que cancelou se a API retornou sucesso"):
 * afirmações de cancelamento só passam se a API principal confirmou, nesta conversa, que
 * aquele pedido está cancelado. O modelo pode errar; a verificação não depende dele.
 */

export interface OutputGuardContext {
  /** Pedidos que a API principal confirmou estarem cancelados (consulta ou cancelamento). */
  readonly verifiedCancelledOrderIds: ReadonlySet<string>;
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
];

const CANCELLATION_CLAIMS = [
  /\b(foi|foram|esta|estao|ja esta|ja estao|ja foi|ja foram|ficou|ficaram|consta como|encontra se)\s+(devidamente\s+|com sucesso\s+|oficialmente\s+)?cancelad[oa]s?\b/g,
  /\bcancelei\b/g,
  /\bcancelamento\s+(do pedido\s+\d{6}\s+)?(foi\s+|esta\s+|ja foi\s+)?(realizado|concluido|efetuado|confirmado|feito|aprovado|processado)\b/g,
  /\bcancelad[oa]s?\s+com\s+sucesso\b/g,
];

const HANDOFF_CLAIMS = [
  /\b(transferi|encaminhei|ja encaminhei|ja transferi)\b/g,
  /\b(foi|esta sendo|ja foi)\s+(transferid|encaminhad)[oa]\b/g,
  /\bprotocolo\s+atd\s?\d+/g,
];

const REFUND_PROMISE =
  /\b(estorno|reembolso|devolucao do valor|dinheiro de volta)\b[^.!?\n]{0,80}\b(\d+\s*(dias?|horas?|uteis)|garantid|imediat|automatic|aprovad|realizad|efetuad|creditad|ja foi)/;

const NEGATION_BEFORE = /\b(nao|nem|sem|ainda nao|nunca)\s+(\S+\s+){0,2}$/;

function normalize(text: string): string {
  return text.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/-/g, ' ');
}

function affirmativeMatches(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) =>
    [...text.matchAll(pattern)].some(
      (match) => !NEGATION_BEFORE.test(text.slice(Math.max(0, match.index - 30), match.index)),
    ),
  );
}

function cancellationClaimIsVerified(text: string, verified: ReadonlySet<string>): boolean {
  if (verified.size === 0) return false;
  const mentioned = [...new Set(text.match(/\b\d{6}\b/g) ?? [])];
  return mentioned.length === 0 || mentioned.every((id) => verified.has(id));
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
  if (
    affirmativeMatches(normalized, CANCELLATION_CLAIMS) &&
    !cancellationClaimIsVerified(normalized, context.verifiedCancelledOrderIds)
  ) {
    return blocked('unverified_cancellation_claim');
  }
  if (!context.handoffCreated && affirmativeMatches(normalized, HANDOFF_CLAIMS)) {
    return blocked('unverified_handoff_claim');
  }
  if (REFUND_PROMISE.test(normalized)) return blocked('refund_promise');

  const reasons: OutputGuardReason[] = [];
  const pii = redactPii(formatted);
  if (pii.detected.length > 0) reasons.push('pii_redacted');
  const text = truncate(pii.text);
  if (text !== pii.text) reasons.push('too_long');

  return { action: reasons.length > 0 ? 'modified' : 'pass', text, reasons };
}

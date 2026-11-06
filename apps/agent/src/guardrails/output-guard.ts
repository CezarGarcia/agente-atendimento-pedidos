import { redactPii } from '@agente/shared';

import { shingles } from '../agent/prompt.js';
import { securityNormalize, stripInvisible } from './normalize.js';

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

/**
 * Marcadores internos do prompt. Comparados com os separadores colapsados ("seguranca-e-limites",
 * "seguranca\_e\_limites"). Os nomes das ferramentas também são internos: o cliente não precisa
 * deles e eles ajudam a montar ataques.
 */
const INTERNAL_MARKERS =
  /<\s*\/?\s*(contexto|escopo|exemplos?)\s*>|(regras|protocolo|contexto|uso|seguranca|estilo|aviso|incertezas)[_\-\\]+(de|da|das|do|e)[_\-\\]+(negocio|cancelamento|sessao|ferramentas|limites|comunicacao|sistema|falhas)|consultar[_\-\\]+pedido|listar[_\-\\]+pedidos|solicitar[_\-\\]+cancelamento|transferir[_\-\\]+para[_\-\\]+humano|pode[_\-\\]+cancelar|numero[_\-\\]+pedido/;

/*
 * Afirmações de cancelamento. Vocabulário amplo (inclusive inglês e o que vem com o cancelamento:
 * estorno, reembolso, "não vai mais ser cobrado"), e a exceção estreita: negação ou hipótese
 * coladas na afirmação. Um falso positivo custa uma resposta genérica; um falso negativo, uma
 * informação errada ao cliente.
 */
const CANCELLATION_CLAIMS = [
  /\b(cancelad|anulad|estornad|reembolsad|desfeit|revertid)[oa]s?\b/g,
  /\b(cancel|anul|estorn|reembols)(ei|amos|ou|aram)\b/g,
  /\b(processei|efetuei|realizei|fiz|concluí|conclui|finalizei|registrei)\s+(o|seu)?\s*(cancelamento|estorno|reembolso)\b/g,
  /\bcancelamento\b[^.!?\n]{0,80}?\b(realizado|concluido|efetuado|efetivado|confirmado|feito|aprovado|processado|finalizado|registrado|deu certo|com sucesso|ok)\b/g,
  /\bcancelamento\b[^.!?\n]{0,30}✅/g,
  /\bcancell?ed\b|\bvoided\b|\brefunded\b/g,
  /\bcancell?ation\b[^.!?\n]{0,40}\b(successful|complete|completed|confirmed|done|went through|processed)\b/g,
  /\bcancelacion\b[^.!?\n]{0,40}\b(exitosa|realizada|completada|confirmada)\b/g,
];

/**
 * Consequências que só um cancelamento produz. Numa frase condicional com a condição ANTES ("se
 * confirmar, o pedido não será mais enviado") explicam o efeito; com a condição depois ("não será
 * mais enviado e, se precisar, é só chamar") continuam sendo afirmação.
 */
const CANCELLATION_CONSEQUENCES = [
  /\bnao (sera|vai ser|vai) mais (ser )?(enviad[oa]s?|entregues?|despachad[oa]s?|cobrad[oa]s?|chegar|sair)\b/g,
  /\bnao (sai|saira|chega|chegara) mais\b/g,
  /\bnao precisa(ra)? mais pagar\b/g,
  /\bja era\b/g,
  /\b(will no longer|won't) (be )?(ship|shipped|delivered|charged|arrive)\b/g,
];
/** Condição no começo da frase ou depois de vírgula ("Se você confirmar, …"); não o "se" reflexivo. */
const CONDITIONAL_CUE =
  /(^|,)\s*(se|caso|quando|apos|depois que|assim que|uma vez|ao (cancelar|confirmar)|if|once|after|when)\b/;

const PERSON = String.raw`(atendente|atendimento humano|humano|pessoa|equipe|especialista|agente|suporte|time de atendimento|setor)`;
const HANDOFF_CLAIMS = [
  new RegExp(
    String.raw`\b(transferi|transferimos|encaminhei|encaminhamos|passei|repassei|direcionei|acionei|chamei)\b[^.!?\n]{0,40}\b${PERSON}\b`,
    'g',
  ),
  new RegExp(
    String.raw`\b(foi|foram|esta sendo|ja foi|ficou|esta)\s+(transferid|encaminhad|direcionad)[oa]s?\b[^.!?\n]{0,30}\b${PERSON}\b`,
    'g',
  ),
  new RegExp(
    String.raw`\b(transferid|encaminhad)[oa]s?\s+(para|pra|ao|a)\s+(um|uma|o|a|nosso|nossa)?\s*${PERSON}\b`,
    'g',
  ),
  new RegExp(
    String.raw`\b(um|uma|o|a|nosso|nossa)\s+${PERSON}\s+(ja\s+)?(vai|ira|esta indo)\s+(te\s+)?(falar|atender|continuar|responder|entrar em contato)`,
    'g',
  ),
  /\b(voce )?(ja )?esta na fila\b/g,
  /\bprotocolo\b[^.!?\n]{0,12}\batd\s?-?\s?\d+/g,
  /\b(i have|i've|we have|we've)\s+(transferred|forwarded|escalated)\b|\btransferred you\b/g,
];

/** Promessas sobre devolução de dinheiro: o agente não tem acesso nem autonomia sobre isso. */
const REFUND_TERM =
  /\b(estorno|estornad|reembols|refund|devolucao do (valor|dinheiro)|dinheiro (de volta|vai voltar|volta)|valor (sera|vai ser) devolvido|credito na fatura)/;
const REFUND_PROMISE =
  /\b(cai|caira|cair|sera|vai|volta|voltar|devolvid|creditad|aprovad|garantid|realizad|efetuad|feit|processad|imediat|automaticamente|em ate \d+|em \d+\s*(dias?|horas?)|\d+\s*dias? uteis|full refund|will get|will be)/;

/*
 * Negação e hipótese só valem coladas na afirmação: entre elas, no máximo palavras vazias
 * ("não FOI cancelado", "nenhum DOS SEUS PEDIDOS FOI cancelado"). "Nem esquenta que tá cancelado"
 * e "Não demorou nada e já foi cancelado" afirmam.
 */
const FILLER = String.raw`(?:ainda|mais|foi|foram|esta|estao|ficou|ficaram|tinha|tem|sido|ser|estar|pode|podem|posso|consigo|o|a|os|as|do|da|dos|das|de|seu|sua|seus|suas|meu|minha|pedido|pedidos|ele|ela|eles|elas|isso|consta|constam|aparece|como|\d{6}|been|was|were|is|are|has|have|the|order|it)`;
const NEGATION_BEFORE = new RegExp(
  String.raw`\b(nao|nem|nunca|jamais|nada|nenhum|nenhuma|not|never|nothing)\s+(?:${FILLER}\s+){0,4}$`,
);
/**
 * "Não posso dizer que foi cancelado", "não consigo confirmar que o pedido 100102 está cancelado",
 * "não deveria ter dito que foi cancelado": a afirmação é negada pelo verbo que a introduz.
 */
const TOKEN = String.raw`[^\s,;:!?.]+`;
const NEGATED_REPORT_BEFORE = new RegExp(
  String.raw`\b(nao|nem|nunca)\s+(?!so\b)(${TOKEN}\s+){0,2}(dizer|dito|afirmar|afirmado|confirmar|confirmado|informar|informado|garantir|escrever|escrito|responder)\s+que(\s+${TOKEN}){0,5}\s*$`,
);
/** Futuro/hipótese colados: "será cancelado", "pode ser cancelado", "quer que seja cancelado". */
const HYPOTHETICAL_BEFORE =
  /\b(sera|serao|seja|sejam|for|forem|fosse|seria|(pode|podem|possa|poderia|vai|vao|deve|devem|precisa|consigo|posso|para|pra|que)\s+(ser|ficar|seja|fique|sejam)|will be|would be|can be|could be|to be|be)\s+$/;
/** "Você quer o pedido 100101 cancelado?" é pergunta, não afirmação. */
const VOLITION_QUESTION = /\b(quer|deseja|gostaria|prefere|posso|devo|confirma|podemos)\b/;
/** Dentro do trecho casado: "o cancelamento NÃO PODE SER feito", "é concluído quando…". */
const NEGATION_INSIDE = new RegExp(
  String.raw`\b(nao|nem|nunca|not|never|cannot)\s+(?:${FILLER}\s+){0,3}\S+$|\b(pode|podem|possa|poderia|precisa|deve|vai|sera|seria)\s+(ser|ficar|estar)\b|\be\s+(realizado|concluido|efetuado|efetivado|confirmado|feito|aprovado|processado|finalizado|registrado)\b|\b(can|could|will|would) be\b`,
);

/**
 * Links: com protocolo, "www." ou qualquer coisa com cara de domínio (o WhatsApp transforma
 * "loja-reembolso.com.br/pix" e "bit.ly/x" em link clicável).
 */
const URL_PATTERN =
  /(?:\bh[tx]{2}ps?:\/\/|\bwww\.)\S+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|br|io|ly|me|app|xyz|info|site|online|link|co|gov|edu|shop|store|top|club|vip|click|biz)\b(?:\/\S*)?|\b(?:\d{1,3}\.){3}\d{1,3}(?:\/\S*)?/gi;

const precededBy = (text: string, index: number, pattern: RegExp, window = 60): boolean =>
  pattern.test(text.slice(Math.max(0, index - window), index));

/**
 * Fim de frase: . ! ? ; ou quebra de linha, exceto o ponto entre dígitos ("R$ 3.475,00"). Tratar o
 * separador de milhar como fim de frase separava o número do pedido da afirmação (visto nos evals).
 */
const SENTENCE_END = /[!?;\n]|\.(?!\d)|(?<!\d)\./g;

function sentenceAround(text: string, index: number): { start: number; end: number } {
  let start = 0;
  let end = text.length;
  for (const match of text.matchAll(SENTENCE_END)) {
    if (match.index < index) start = match.index + 1;
    else {
      end = match.index;
      break;
    }
  }
  return { start, end };
}

/** Ocorrências afirmativas: nem negadas nem hipotéticas, conferindo só o que está colado. */
function affirmativeMatches(
  text: string,
  patterns: readonly RegExp[],
  { checkInside = false } = {},
): RegExpMatchArray[] {
  return patterns.flatMap((pattern) =>
    [...text.matchAll(pattern)].filter((match) => {
      if (precededBy(text, match.index, NEGATION_BEFORE)) return false;
      if (precededBy(text, match.index, NEGATED_REPORT_BEFORE, 100)) return false;
      if (precededBy(text, match.index, HYPOTHETICAL_BEFORE, 30)) return false;
      if (checkInside && NEGATION_INSIDE.test(match[0])) return false;
      const { start, end } = sentenceAround(text, match.index);
      const endsWithQuestion = text[end] === '?';
      if (endsWithQuestion && VOLITION_QUESTION.test(text.slice(start, match.index))) return false;
      return true;
    }),
  );
}

/** Número de pedido: 6 dígitos, inclusive escrito "100 102" ou "100.102". */
const ORDER_ID = /(?<![\d.,])\d{3}[.\s]?\d{3}(?!\d|[.,]\d)/g;
const NON_CANCELLED_STATUS =
  /\b(em processamento|processando|enviad[oa]|entregue|aguardando|ativo|continua|segue|a caminho|nao (foi|esta) cancelad)/;

interface OrderMention {
  readonly id: string;
  readonly index: number;
}

function orderMentions(text: string): OrderMention[] {
  return [...text.matchAll(ORDER_ID)].map((m) => ({ id: m[0].replace(/\D/g, ''), index: m.index }));
}

/**
 * Pedidos a que uma afirmação se refere. Na frase, todos os números citados, menos os que trazem
 * o próprio status ("o 100201 (em processamento) e o 100202 (cancelado)"): "O 100202 foi
 * cancelado, e o 100102 também" afirma sobre os dois. Sem número na frase, o mais próximo antes
 * dela na resposta (cabeçalho "*Pedido 100102*" e a linha "Status: cancelado"), ou o primeiro depois.
 */
function ordersReferencedBy(
  text: string,
  match: RegExpMatchArray,
  mentions: OrderMention[],
): string[] {
  const index = match.index ?? 0;
  const claimEnd = index + match[0].length;
  const { start, end } = sentenceAround(text, index);
  const inSentence = mentions.filter((m) => m.index >= start && m.index < end);
  if (inSentence.length > 0) {
    return inSentence
      .filter((mention, i) => {
        const segmentEnd = inSentence[i + 1]?.index ?? end;
        const coversClaim = mention.index < claimEnd && segmentEnd > index;
        return coversClaim || !NON_CANCELLED_STATUS.test(text.slice(mention.index, segmentEnd));
      })
      .map((m) => m.id);
  }
  const before = mentions.filter((m) => m.index < start).at(-1);
  if (before) return [before.id];
  const after = mentions.find((m) => m.index >= end);
  return after ? [after.id] : [];
}

/**
 * "Pedidos enviados, entregues ou cancelados não podem…": particípio no plural sem verbo antes e
 * sem número de pedido descreve uma categoria, não um pedido. "Seus pedidos FORAM cancelados" afirma.
 */
function isGenericCategory(text: string, match: RegExpMatchArray): boolean {
  if (!match[0].endsWith('s')) return false;
  const { start } = sentenceAround(text, match.index ?? 0);
  const before = text.slice(Math.max(start, (match.index ?? 0) - 40), match.index);
  return !/\b(foram|estao|ficaram|sao|tiveram|seus|suas|todos|were|are|have been|your)\b/.test(
    before,
  );
}

const QUOTES = new Set(['"', '“', '”', "'", '‘', '’', '«', '»']);

/** "O 100202 está cancelado. O 100102 também.": a frase elíptica seguinte herda a afirmação. */
const ELLIPSIS = /\b(tambem|igualmente|idem|too|as well)\b/;

function cancellationClaimsAreVerified(text: string, context: OutputGuardContext): boolean {
  const mentions = orderMentions(text);
  const consequences = affirmativeMatches(text, CANCELLATION_CONSEQUENCES).filter((match) => {
    const index = match.index ?? 0;
    // Gíria citada entre aspas é menção, não afirmação: 'não vou responder "já era"' (o modelo
    // recusando o pedido do atacante; visto nos evals).
    if (QUOTES.has(text[index - 1] ?? '') && QUOTES.has(text[index + match[0].length] ?? '')) {
      return false;
    }
    const { start } = sentenceAround(text, index);
    return !CONDITIONAL_CUE.test(text.slice(start, index));
  });
  const claims = affirmativeMatches(text, CANCELLATION_CLAIMS, { checkInside: true }).filter(
    (match) => {
      // Explicação condicional ("assim que você confirmar, o cancelamento é concluído").
      const { start } = sentenceAround(text, match.index ?? 0);
      return !CONDITIONAL_CUE.test(text.slice(start, match.index));
    },
  );
  return [...claims, ...consequences].every((match) => {
    const referenced = ordersReferencedBy(text, match, mentions);
    const { end } = sentenceAround(text, match.index ?? 0);
    const next = sentenceAround(text, end + 1);
    const nextSentence = text.slice(next.start, next.end);
    if (
      end < text.length &&
      ELLIPSIS.test(nextSentence) &&
      !NON_CANCELLED_STATUS.test(nextSentence)
    ) {
      referenced.push(
        ...mentions.filter((m) => m.index >= next.start && m.index < next.end).map((m) => m.id),
      );
    }
    if (referenced.length === 0 && isGenericCategory(text, match)) return true;
    // O modelo nunca executa um cancelamento: uma afirmação sem número só pode se referir a um
    // pedido que ele acabou de consultar individualmente e que a API mostrou cancelado.
    if (referenced.length === 0) return context.verifiedThisTurn.size === 1;
    return referenced.every((id) => context.verifiedCancelledOrderIds.has(id));
  });
}

/**
 * Promessa de estorno, avaliada por oração: a negação só protege a oração em que está ("Não se
 * preocupe, o estorno cai em 5 dias úteis" promete).
 */
function hasRefundPromise(text: string): boolean {
  return text
    .split(/[.!?\n,;:]+/)
    .some(
      (clause) =>
        REFUND_TERM.test(clause) &&
        REFUND_PROMISE.test(clause) &&
        !/\b(nao|nem|nunca|sem)\b/.test(clause) &&
        !/^\s*(se|caso|quando|assim que)\b/.test(clause),
    );
}

/** O canary não pode sair nem ofuscado: minúsculas, separado, invertido ou em base64. */
function leaksCanary(raw: string, normalized: string, canary: string): boolean {
  const code = canary
    .replace(/^CANARY-/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  if (code.length < 6) return raw.includes(canary);
  const compact = normalized.replace(/[^a-z0-9]/g, '');
  if (compact.includes(code) || compact.includes(code.split('').reverse().join(''))) return true;
  return (raw.match(/[A-Za-z0-9+/]{12,}={0,2}/g) ?? []).some((token) => {
    const decoded = Buffer.from(token, 'base64').toString('utf8').toLowerCase();
    return decoded.replace(/[^a-z0-9]/g, '').includes(code);
  });
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
  // As verificações valem para o que o cliente vai ler: o corte de tamanho vem antes delas (um
  // corte poderia tirar o "se você confirmar" de uma frase condicional).
  const shortened = truncate(formatted);

  const normalized = securityNormalize(shortened);
  const promptShingles = [...shingles(normalized)].filter((shingle) =>
    context.promptFingerprint?.has(shingle),
  );
  if (
    promptShingles.length >= MIN_PROMPT_SHINGLES ||
    leaksCanary(shortened, normalized, context.canary) ||
    INTERNAL_MARKERS.test(normalizeKeepingSeparators(shortened))
  ) {
    return blocked('prompt_leak');
  }
  if (!cancellationClaimsAreVerified(normalized, context)) {
    return blocked('unverified_cancellation_claim');
  }
  if (!context.handoffCreated) {
    const handoffClaims = affirmativeMatches(normalized, HANDOFF_CLAIMS).filter((match) => {
      const { start } = sentenceAround(normalized, match.index ?? 0);
      return !CONDITIONAL_CUE.test(normalized.slice(start, match.index));
    });
    if (handoffClaims.length > 0) return blocked('unverified_handoff_claim');
  }
  if (hasRefundPromise(normalized)) return blocked('refund_promise');

  const reasons: OutputGuardReason[] = [];
  // O agente não envia links: um link na resposta só pode ter vindo de dado externo (phishing).
  // Dados pessoais antes dos links: o domínio de um e-mail não pode virar "[link removido]".
  const pii = redactPii(stripInvisible(shortened.normalize('NFKC')));
  if (pii.detected.length > 0) reasons.push('pii_redacted');
  const text = pii.text.replace(URL_PATTERN, '[link removido]');
  if (text !== pii.text) reasons.push('link_removed');
  if (shortened !== formatted) reasons.push('too_long');

  return { action: reasons.length > 0 ? 'modified' : 'pass', text, reasons };
}

/** Para os marcadores: normalizado, mas mantendo "_", "-" e "\" (separadores dos nomes internos). */
function normalizeKeepingSeparators(text: string): string {
  return stripInvisible(text.normalize('NFKC'))
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}/gu, '');
}

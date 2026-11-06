import { securityNormalize } from './normalize.js';

/**
 * Detector heurístico de tentativas de manipulação do modelo (prompt injection), em PT-BR e EN.
 *
 * Isto NÃO é a defesa principal: heurísticas sempre podem ser contornadas. A defesa real é
 * arquitetural (o modelo não tem capacidade de causar dano sem passar pela confirmação
 * determinística e pela API). O detector serve para:
 *  - neutralizar conteúdo suspeito vindo de APIs externas antes de chegar ao modelo;
 *  - sinalizar ao agente que a mensagem do cliente merece cautela extra;
 *  - gerar métricas e logs de tentativas (sem registrar o conteúdo).
 */

export type InjectionSignal =
  'instruction_override' | 'prompt_extraction' | 'role_play' | 'role_markers' | 'action_coercion';

export interface InjectionAssessment {
  readonly suspicious: boolean;
  readonly signals: readonly InjectionSignal[];
}

const PATTERNS: Readonly<Record<InjectionSignal, readonly RegExp[]>> = {
  instruction_override: [
    /\b(ignore|ignora|ignorar|desconsidere|desconsiderar|esqueca|esquecer|esqueça|override|disregard|forget)\b.{0,40}\b(instruc|regra|rule|instruction|prompt|diretriz|orienta|politica|policy|anterior|previous|above|acima|antes|dito|disseram|before|said|told)/,
    /\b(nova|novas|new)\s+(instruc|regra|rule|instruction|diretriz)/,
    /\b(sem|without)\s+(restric|regras|limites|rules|restrictions|limits)/,
  ],
  prompt_extraction: [
    /\b(system\s*prompt|prompt\s+(do|de)\s+sistema|instruc\w*\s+(internas|do sistema|iniciais)|your\s+(instructions|prompt|rules))/,
    /\b(revele|revelar|mostre|mostrar|repita|repetir|imprima|exiba|print|reveal|show|repeat|leak)\b.{0,40}\b(prompt|instruc|regras|rules|instructions|configura)/,
  ],
  role_play: [
    /\b(voce agora e|você agora é|a partir de agora voce|you are now|act as|aja como|finja (ser|que)|pretend (to be|you)|roleplay|modo (desenvolvedor|dev|admin|deus)|developer mode|jailbreak|\bdan\b)/,
    /\b(sou|i am|i'm)\s+(o |a |um |uma )?(gerente|administrador|admin|desenvolvedor|developer|supervisor|dono|owner|ceo)\b/,
  ],
  role_markers: [
    /(^|\n)\s*(system|assistant|sistema|developer)\s*:/,
    /<\/?\s*(system|assistant|instructions?|tool|function)[^>]*>/,
    /\[(inst|system)\]|<<sys>>|###\s*(instruction|system)/,
    // "SYSTEM NOTE TO ASSISTANT: …", "mensagem para o assistente: …" (visto nos evals).
    /\b(system|developer|admin|sistema)\s+(note|message|prompt|instruction|override|nota|mensagem|aviso)s?\b/,
    /\b(note|message|instructions?|nota|mensagem|recado|instruc\w*)\s+(to|for|para)\s+(the\s+|o\s+|a\s+)?(assistant|ai|model|agent|bot|chatbot|assistente|ia|modelo|agente)\b/,
  ],
  action_coercion: [
    /\b(cancel(e|a|ar)?|cancel)\b.{0,30}\b(pedido|order)/,
    /\b(chame|chamar|execute|executar|call|invoke|run)\b.{0,30}\b(ferramenta|tool|funcao|function|api)/,
    /\b(reembolso|estorno|refund)\b.{0,30}\b(imediat|agora|now|aprovad)/,
    // Em conteúdo externo: ordens dirigidas ao atendimento e afirmações sobre o pedido do cliente.
    /\b(tell|inform|notify|say to)\s+(the\s+)?(customer|user|client|buyer)\b/,
    /\b(diga|informe|avise|responda|fale)\s+(ao|a|para o|pro)\s+(cliente|usuario|comprador)\b/,
    /\b(order|pedido)\b.{0,40}\b(cancell?ed|cancelad[oa]|refunded|estornad[oa]|reembolsad[oa])\b/,
    /\b(collect|ask for|request|colete|coletar|pe[cç]a|pedir|solicite)\b.{0,30}\b(card|credit card|cartao|cpf|senha|password)\b/,
    // Promessa comercial em dado de produto: o título aparece na pergunta de confirmação (texto
    // fixo do sistema) e "reembolso garantido em 24h" viraria promessa da loja (visto nos evals).
    /\b(reembolso|estorno|refund(ed)?|cashback|dinheiro de volta|money back|devolucao do (valor|dinheiro))\b/,
    /\b(garantid[oa]s?|guaranteed|cupom|coupon|promo code|codigo promocional)\b/,
    // Ordens e afirmações sobre a compra, em qualquer formulação que a revisão adversarial usou.
    /\b(informe|diga|avise|afirme|confirme|responda|dile|let)\b.{0,40}\b(compra|pedido|pagamento|purchase|order|payment|compra)\b/,
    /\b(compra|purchase|pedido|order|pagamento|payment)\b.{0,40}\b(foi|was|has been|fue|esta|is)\s+(cancelad|anulad|estornad|reembolsad|encerrad|voided|refunded|reembolsada|anulada|cancell?ed)/,
    /\b(ao responder|when answering|always say|sempre diga|agora voce e|you are now|esqueca o que|forget what)\b/,
    /\b(chave pix|pix key|codigo (que chegou|recebido) por sms|sms code|numero do cartao|card number)\b/,
    /\b(atencao|nota|note|aviso)\s+(ao|a|para o|para a|to the|to)?\s*(atendente|assistente|suporte|support|bot|ia|ai|agent)\b/,
  ],
};

/** Mesma normalização dos outros guardrails: invisíveis, homóglifos, acentos, letras espaçadas. */
const normalize = securityNormalize;

export function assessInjection(
  text: string,
  options: { includeActionCoercion: boolean },
): InjectionAssessment {
  const normalized = normalize(text);
  const signals = (Object.keys(PATTERNS) as InjectionSignal[]).filter((signal) => {
    if (signal === 'action_coercion' && !options.includeActionCoercion) return false;
    return PATTERNS[signal].some((pattern) => pattern.test(normalized));
  });
  return { suspicious: signals.length > 0, signals };
}

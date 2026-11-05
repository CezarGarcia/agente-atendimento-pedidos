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
    /\b(ignore|ignora|ignorar|desconsidere|desconsiderar|esqueca|esquecer|esqueça|override|disregard|forget)\b.{0,40}\b(instruc|regra|rule|instruction|prompt|diretriz|orienta|politica|policy|anterior|previous|above|acima)/,
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
  ],
  action_coercion: [
    /\b(cancel(e|a|ar)?|cancel)\b.{0,30}\b(pedido|order)/,
    /\b(chame|chamar|execute|executar|call|invoke|run)\b.{0,30}\b(ferramenta|tool|funcao|function|api)/,
    /\b(reembolso|estorno|refund)\b.{0,30}\b(imediat|agora|now|aprovad)/,
  ],
};

function normalize(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[\u200B-\u200F\u2060-\u206F\uFEFF]/g, '')
    .toLowerCase();
}

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

import { createHmac } from 'node:crypto';

/**
 * Proteção de dados pessoais (LGPD) em texto livre.
 *
 * Uso principal: mascarar dados que o cliente digita espontaneamente (CPF, cartão, e-mail…)
 * ANTES de enviar a mensagem ao modelo de IA. O fluxo de atendimento não precisa desses
 * dados, então o princípio de minimização manda não repassá-los a terceiros.
 */
export type PiiKind = 'email' | 'card' | 'cnpj' | 'cpf' | 'phone';

export interface PiiRedactionResult {
  readonly text: string;
  /** Tipos encontrados (sem os valores), útil para métricas e logs. */
  readonly detected: readonly PiiKind[];
}

const PLACEHOLDER: Record<PiiKind, string> = {
  email: '[EMAIL REMOVIDO]',
  card: '[CARTÃO REMOVIDO]',
  cnpj: '[CNPJ REMOVIDO]',
  cpf: '[CPF REMOVIDO]',
  phone: '[TELEFONE REMOVIDO]',
};

/*
 * Os padrões aceitam os separadores que as pessoas usam (ponto, hífen, espaço, barra, sublinhado,
 * até três seguidos) e conferem dígitos verificadores onde existem (CPF, cartão). A revisão
 * adversarial achou "529 982 247 25", "4111.1111.1111.1111", "+5511987654321", "(011) 98765-4321",
 * e-mail com espaço em volta do @ e com acento: todos passavam.
 */
const SEP = String.raw`[\s.\-/_]{0,3}`;
const EMAIL = /[\p{L}\p{N}._%+-]+\s?@\s?[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}/gu;
const CARD_CANDIDATE = new RegExp(String.raw`(?<!\d)\d(?:${SEP}\d){12,18}(?!\d)`, 'g');
const CNPJ = new RegExp(
  String.raw`(?<!\d)\d{2}${SEP}\d{3}${SEP}\d{3}${SEP}\d{4}${SEP}\d{2}(?!\d)`,
  'g',
);
const CPF_FORMATTED = /\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/g;
const CPF_CANDIDATE = new RegExp(
  String.raw`(?<!\d)\d{3}${SEP}\d{3}${SEP}\d{3}${SEP}\d{2}(?!\d)`,
  'g',
);
/**
 * Telefone não pode estar grudado em letras: "QB987654321BR" é código de rastreio (o número do
 * meio parece um celular). Sem essa borda, o rastreio virava "QB[TELEFONE REMOVIDO]BR" (evals).
 */
const PHONE = new RegExp(
  String.raw`(?<![\p{L}\d])(?:\+?\s?55${SEP})?(?:\(?0?\d{2}\)?${SEP})?9?${SEP}\d{4}${SEP}\d{4}(?![\p{L}\d])`,
  'gu',
);

const onlyDigits = (value: string): string => value.replace(/\D/g, '');

export function isValidLuhn(digits: string): boolean {
  let sum = 0;
  let shouldDouble = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let digit = Number(digits[i]);
    if (shouldDouble) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    shouldDouble = !shouldDouble;
  }
  return digits.length >= 13 && sum % 10 === 0;
}

export function isValidCpf(value: string): boolean {
  const digits = onlyDigits(value);
  if (digits.length !== 11 || /^(\d)\1{10}$/.test(digits)) return false;
  const checkDigit = (length: number): number => {
    let sum = 0;
    for (let i = 0; i < length; i += 1) sum += Number(digits[i]) * (length + 1 - i);
    const rest = (sum * 10) % 11;
    return rest === 10 ? 0 : rest;
  };
  return checkDigit(9) === Number(digits[9]) && checkDigit(10) === Number(digits[10]);
}

/**
 * Mascara dados pessoais em texto livre. A ordem importa: padrões mais específicos primeiro,
 * para que um número de cartão não seja confundido com telefone, por exemplo.
 */
export function redactPii(input: string): PiiRedactionResult {
  const detected = new Set<PiiKind>();
  const replace = (kind: PiiKind) => (): string => {
    detected.add(kind);
    return PLACEHOLDER[kind];
  };

  // Largura total e invisíveis viram o equivalente simples antes dos padrões ("５２９…").
  let text = input
    .normalize('NFKC')
    .replace(/[\u{200B}-\u{200F}\u{2060}-\u{2064}\u{FEFF}\u{00AD}]/gu, '')
    .replace(EMAIL, replace('email'));
  text = text.replace(CARD_CANDIDATE, (match) => {
    if (!isValidLuhn(onlyDigits(match))) return match;
    detected.add('card');
    return PLACEHOLDER.card;
  });
  text = text.replace(CNPJ, replace('cnpj'));
  text = text.replace(CPF_FORMATTED, replace('cpf'));
  text = text.replace(CPF_CANDIDATE, (match) => {
    if (!isValidCpf(match)) return match;
    detected.add('cpf');
    return PLACEHOLDER.cpf;
  });
  text = text.replace(PHONE, replace('phone'));

  return { text, detected: [...detected] };
}

/**
 * Pseudonimização estável para logs: permite correlacionar eventos do mesmo cliente
 * sem registrar o identificador real. Usa HMAC (com segredo) para impedir reversão
 * por força bruta, o que um hash simples de telefone não impediria.
 */
export function pseudonymize(value: string, secret: string, prefix = 'ref'): string {
  const digest = createHmac('sha256', secret).update(value).digest('hex').slice(0, 16);
  return `${prefix}_${digest}`;
}

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

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const CARD_CANDIDATE = /\b\d(?:[ -]?\d){12,18}\b/g;
const CNPJ = /\b\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}\b|\b\d{14}\b/g;
const CPF_FORMATTED = /\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/g;
const CPF_DIGITS = /\b\d{11}\b/g;
const PHONE = /(?:\+?55[\s-]?)?(?:\(\d{2}\)|\b\d{2})[\s-]?9?\d{4}[\s-]?\d{4}\b/g;

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

  let text = input.replace(EMAIL, replace('email'));
  text = text.replace(CARD_CANDIDATE, (match) => {
    if (!isValidLuhn(onlyDigits(match))) return match;
    detected.add('card');
    return PLACEHOLDER.card;
  });
  text = text.replace(CNPJ, replace('cnpj'));
  text = text.replace(CPF_FORMATTED, replace('cpf'));
  text = text.replace(CPF_DIGITS, (match) => {
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

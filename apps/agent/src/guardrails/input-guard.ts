import { redactPii, type PiiKind } from '@agente/shared';

import { assessInjection, type InjectionAssessment } from './injection-signals.js';

export const MAX_INPUT_LENGTH = 1_000;

export interface InputInspection {
  /** Texto que segue para o modelo e para o histórico: sem dados pessoais. */
  readonly text: string;
  readonly piiDetected: readonly PiiKind[];
  readonly injection: InjectionAssessment;
  readonly tooLong: boolean;
  readonly empty: boolean;
}

/**
 * Guardrail de entrada (determinístico, roda antes do modelo):
 *  - mascara dados pessoais que o fluxo não usa (CPF, cartão, e-mail…): minimização de dados;
 *  - sinaliza padrões de tentativa de manipulação (o agente é avisado, a regra não muda);
 *  - limita o tamanho (mensagens enormes são típicas de payloads de injeção e custam caro).
 */
export function inspectInput(raw: string): InputInspection {
  const trimmed = raw.trim();
  const { text, detected } = redactPii(trimmed);
  return {
    text,
    piiDetected: detected,
    injection: assessInjection(trimmed, { includeActionCoercion: false }),
    tooLong: trimmed.length > MAX_INPUT_LENGTH,
    empty: trimmed.length === 0,
  };
}

import { stripInvisible } from './normalize.js';

/**
 * Sanitização de texto vindo de fontes não confiáveis (APIs externas) antes de chegar ao modelo.
 * Remove caracteres de controle e invisíveis (usados para esconder instruções), neutraliza
 * sinais de tags (para não imitar delimitadores do prompt) e limita o tamanho.
 */
export function sanitizeUntrustedText(value: string, maxLength: number): string {
  const cleaned = stripInvisible(value.normalize('NFKC'))
    // caracteres invisíveis, direcionais, soft hyphen e tags Unicode (escondem texto do leitor
    // humano e quebram a detecção: "Ig­nore previous in­structions" com soft hyphen passava)
    .replace(/[\u202A-\u202E]/g, '')
    // caracteres de controle, incluindo quebras de linha
    .replace(/\p{Cc}/gu, ' ')
    // sinais de tag viram aspas angulares: o texto continua legível, mas não abre/fecha tags
    .replace(/</g, '‹')
    .replace(/>/g, '›')
    .replace(/\s+/g, ' ')
    .trim();

  if (cleaned.length <= maxLength) return cleaned;
  return `${cleaned.slice(0, maxLength - 1).trimEnd()}…`;
}

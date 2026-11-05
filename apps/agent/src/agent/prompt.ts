import { createHash, createHmac } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Carrega o system prompt versionado (prompts/system-prompt.md).
 *
 * - A versão é o hash do conteúdo: cada log de chamada ao modelo registra exatamente qual
 *   prompt foi usado, o que permite comparar comportamento entre versões (e nos evals).
 * - O marcador secreto (canary) é derivado de um segredo + a versão do prompt: é imprevisível
 *   para quem não tem o segredo, mas IDÊNTICO entre reinícios e réplicas. Isso importa: o texto
 *   de `system` precisa ser exatamente o mesmo em todos os turnos de uma conversa, senão os blocos
 *   de raciocínio guardados no histórico deixam de valer e a API recusa a requisição.
 *   Se aparecer numa resposta, o guardrail de saída sabe que houve vazamento das instruções.
 */
export interface SystemPrompt {
  readonly text: string;
  readonly version: string;
  readonly canary: string;
  /** Sequências de palavras do prompt, para detectar respostas que o reproduzem literalmente. */
  readonly fingerprint?: ReadonlySet<string>;
}

const SHINGLE_SIZE = 8;

const words = (text: string): string[] =>
  text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);

/**
 * Janelas de 8 palavras consecutivas (shingles) de um texto normalizado, sem atravessar o fim de
 * uma frase ou de uma linha. Atravessar gerava falso positivo: "…não puderam ser carregados agora.
 * Se precisar, …" coincidia com o fim de uma instrução seguido do início da próxima.
 */
export function shingles(text: string): Set<string> {
  const result = new Set<string>();
  for (const sentence of text.split(/[.!?;\n]+/)) {
    const tokens = words(sentence);
    for (let i = 0; i + SHINGLE_SIZE <= tokens.length; i += 1) {
      result.add(tokens.slice(i, i + SHINGLE_SIZE).join(' '));
    }
  }
  return result;
}

/**
 * Seções que o modelo pode reproduzir: os exemplos são respostas-modelo, e o escopo e as regras de
 * negócio são públicos (explicá-los ao cliente é o trabalho do agente). Nos evals, "Pedidos
 * aguardando pagamento não podem ser cancelados por este canal" era bloqueado por repetir a regra 1.
 * O que não pode vazar é o funcionamento: contexto, uso das ferramentas, protocolo, segurança.
 */
const PUBLIC_SECTIONS = /<(exemplos|escopo|regras_de_negocio)>[\s\S]*?<\/\1>/g;

/** Impressão digital do prompt, sem as seções públicas. */
export function promptFingerprint(text: string): Set<string> {
  return shingles(text.replace(PUBLIC_SECTIONS, ' '));
}

const CANDIDATE_DIRS = ['../../prompts/', '../prompts/', './prompts/'];

function locatePromptFile(): string {
  for (const dir of CANDIDATE_DIRS) {
    const candidate = fileURLToPath(new URL(`${dir}system-prompt.md`, import.meta.url));
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('prompts/system-prompt.md não encontrado');
}

export function loadSystemPrompt(canarySecret: string): SystemPrompt {
  const template = readFileSync(locatePromptFile(), 'utf8');
  const version = `system-prompt@${createHash('sha256').update(template).digest('hex').slice(0, 10)}`;
  const canary = `CANARY-${createHmac('sha256', canarySecret).update(version).digest('hex').slice(0, 12)}`;
  const text = template.replaceAll('{{CANARY}}', canary);
  return { text, version, canary, fingerprint: promptFingerprint(text) };
}

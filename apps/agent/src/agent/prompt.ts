import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Carrega o system prompt versionado (prompts/system-prompt.md).
 *
 * - A versão é o hash do conteúdo: cada log de chamada ao modelo registra exatamente qual
 *   prompt foi usado, o que permite comparar comportamento entre versões (e nos evals).
 * - O marcador secreto (canary) é inserido em tempo de execução e não entra no hash. Se ele
 *   aparecer numa resposta, o guardrail de saída sabe que houve vazamento das instruções.
 */
export interface SystemPrompt {
  readonly text: string;
  readonly version: string;
  readonly canary: string;
}

const CANDIDATE_DIRS = ['../../prompts/', '../prompts/', './prompts/'];

function locatePromptFile(): string {
  for (const dir of CANDIDATE_DIRS) {
    const candidate = fileURLToPath(new URL(`${dir}system-prompt.md`, import.meta.url));
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('prompts/system-prompt.md não encontrado');
}

export function loadSystemPrompt(
  canary = `CANARY-${randomBytes(6).toString('hex')}`,
): SystemPrompt {
  const template = readFileSync(locatePromptFile(), 'utf8');
  const version = `system-prompt@${createHash('sha256').update(template).digest('hex').slice(0, 10)}`;
  return { text: template.replaceAll('{{CANARY}}', canary), version, canary };
}

/**
 * Modelos validados com este harness. Todos aceitam o que a requisição usa: mensagens de sistema
 * no meio da conversa, `output_config.effort`, ferramentas `strict` e raciocínio adaptativo com
 * blocos preservados. Outro modelo (ex.: claude-sonnet-5, que não aceita mensagens de sistema no
 * meio da conversa) teria toda requisição recusada com 400, então a configuração não o aceita.
 */
export const SUPPORTED_MODELS = [
  'claude-haiku-5-5',
  'claude-sonnet-5-5',
  'claude-opus-5-5',
] as const;

export type SupportedModel = (typeof SUPPORTED_MODELS)[number];

export const isSupportedModel = (model: string): model is SupportedModel =>
  (SUPPORTED_MODELS as readonly string[]).includes(model);

/**
 * Teto de tokens de saída por chamada (raciocínio + resposta). É um limite contra respostas que
 * fogem do controle, não uma meta: as respostas têm no máximo 1.000 caracteres.
 */
export const DEFAULT_MAX_TOKENS = 8_192;

import { z } from 'zod';

const secret = z.string().min(16, 'precisa ter ao menos 16 caracteres');

/** Variável definida como string vazia (comum no docker-compose) conta como ausente. */
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema.optional());

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3002),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  MIGRATE_ON_START: z.stringbool().default(true),

  ORDERS_API_URL: z.url(),
  ORDERS_API_KEY: secret,
  FAKESTORE_BASE_URL: z.url().default('https://fakestoreapi.com'),

  ANTHROPIC_API_KEY: optional(z.string()),
  /** Permite apontar para um servidor fake nos testes E2E. */
  ANTHROPIC_BASE_URL: optional(z.url()),
  LLM_MODEL: z.string().default('claude-haiku-5-5'),
  LLM_EFFORT: z.enum(['low', 'medium', 'high']).default('low'),
  LLM_MAX_TOKENS: z.coerce.number().int().min(256).max(16_000).default(2_048),
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  LLM_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),

  /** Segredo compartilhado com a plataforma de mensagens para assinar os webhooks (HMAC). */
  CHANNEL_WEBHOOK_SECRET: secret,
  LOG_PSEUDONYM_SECRET: secret,
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  LOG_PRETTY: z.stringbool().default(false),

  CONVERSATION_IDLE_MINUTES: z.coerce.number().int().positive().default(30),
  CONFIRMATION_TTL_MINUTES: z.coerce.number().int().positive().default(10),
  MESSAGES_PER_MINUTE: z.coerce.number().int().positive().default(15),

  /** Habilita o simulador e os controles de demonstração (falhas simuladas). */
  DEMO_MODE: z.stringbool().default(false),
  SIMULATOR_DIST_DIR: optional(z.string()),
});

export type AgentConfig = z.infer<typeof EnvSchema>;

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

const DEV_SECRET_MARKER = /change-me/i;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new ConfigError(`Configuração inválida: ${problems}`);
  }
  const config = parsed.data;
  if (config.NODE_ENV === 'production') {
    if (config.DEMO_MODE) throw new ConfigError('DEMO_MODE não pode ser habilitado em produção');
    if (!config.ANTHROPIC_API_KEY)
      throw new ConfigError('ANTHROPIC_API_KEY é obrigatória em produção');
    const secrets = [
      config.ORDERS_API_KEY,
      config.CHANNEL_WEBHOOK_SECRET,
      config.LOG_PSEUDONYM_SECRET,
    ];
    if (secrets.some((value) => DEV_SECRET_MARKER.test(value))) {
      throw new ConfigError('Segredos de desenvolvimento (change-me) não são aceitos em produção');
    }
  }
  return config;
}

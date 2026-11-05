import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3001),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  /**
   * Chaves aceitas no formato `cliente:segredo`, separadas por vírgula. O nome do cliente vai
   * para a trilha de auditoria; várias chaves permitem rotação sem indisponibilidade.
   */
  ORDERS_API_KEYS: z
    .string()
    .transform((value) =>
      value
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map((entry) => {
          const separator = entry.indexOf(':');
          return {
            clientName: entry.slice(0, Math.max(separator, 0)),
            key: entry.slice(separator + 1),
          };
        }),
    )
    .pipe(
      z
        .array(
          z.object({
            clientName: z.string().regex(/^[a-z][a-z0-9-]{1,40}$/, 'use o formato cliente:segredo'),
            key: z.string().min(16, 'o segredo de cada chave precisa ter ao menos 16 caracteres'),
          }),
        )
        .min(1),
    ),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  LOG_PRETTY: z.stringbool().default(false),
  LOG_PSEUDONYM_SECRET: z.string().min(16),
  MIGRATE_ON_START: z.stringbool().default(true),
  SEED_ON_START: z.stringbool().default(false),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(300),
  /** Habilita rotas de demonstração (reset de dados, simular despacho). Nunca em produção. */
  DEMO_MODE: z.stringbool().default(false),
});

export type Config = z.infer<typeof EnvSchema>;

/** Valores padrão do docker-compose local: proibidos quando NODE_ENV=production. */
const DEV_SECRET_MARKER = /change-me/i;

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

/** Falha rápido na inicialização, informando quais variáveis estão inválidas (sem expor valores). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
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
    const usesDevSecret =
      config.ORDERS_API_KEYS.some(({ key }) => DEV_SECRET_MARKER.test(key)) ||
      DEV_SECRET_MARKER.test(config.LOG_PSEUDONYM_SECRET);
    if (usesDevSecret) {
      throw new ConfigError('Segredos de desenvolvimento (change-me) não são aceitos em produção');
    }
  }
  return config;
}

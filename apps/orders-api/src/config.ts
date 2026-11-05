import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3001),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  /** Chaves aceitas, separadas por vírgula (permite rotação sem indisponibilidade). */
  ORDERS_API_KEYS: z
    .string()
    .transform((value) =>
      value
        .split(',')
        .map((key) => key.trim())
        .filter(Boolean),
    )
    .pipe(z.array(z.string().min(16, 'cada chave precisa ter ao menos 16 caracteres')).min(1)),
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
  if (parsed.data.NODE_ENV === 'production' && parsed.data.DEMO_MODE) {
    throw new ConfigError('DEMO_MODE não pode ser habilitado em produção');
  }
  return parsed.data;
}

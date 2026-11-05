import { describe, expect, it } from 'vitest';

import { ConfigError, loadConfig } from './config.js';

const valid = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/orders',
  ORDERS_API_KEYS: 'agent-service:dev-agent-key-change-me',
  LOG_PSEUDONYM_SECRET: 'dev-pseudonym-secret-change-me',
};

describe('loadConfig', () => {
  it('aplica valores padrão seguros', () => {
    expect(loadConfig(valid)).toMatchObject({
      PORT: 3001,
      NODE_ENV: 'development',
      MIGRATE_ON_START: true,
      SEED_ON_START: false,
      DEMO_MODE: false,
      ORDERS_API_KEYS: ['agent-service:dev-agent-key-change-me'],
    });
  });

  it('falha rápido listando as variáveis inválidas, sem expor valores', () => {
    const attempt = () =>
      loadConfig({ ...valid, DATABASE_URL: 'mysql://segredo@host/db', ORDERS_API_KEYS: 'curta' });
    expect(attempt).toThrow(ConfigError);
    expect(attempt).toThrow(/DATABASE_URL/);
    expect(attempt).toThrow(/ORDERS_API_KEYS/);
    expect(attempt).not.toThrow(/segredo/);
  });

  it('impede habilitar rotas de demonstração em produção', () => {
    expect(() => loadConfig({ ...valid, NODE_ENV: 'production', DEMO_MODE: 'true' })).toThrow(
      /DEMO_MODE/,
    );
  });
});

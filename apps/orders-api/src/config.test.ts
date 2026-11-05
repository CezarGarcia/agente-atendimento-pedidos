import { describe, expect, it } from 'vitest';

import { ConfigError, loadConfig } from './config.js';

const valid = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/orders',
  ORDERS_API_KEYS: 'agent-service:dev-agent-key-change-me',
  LOG_PSEUDONYM_SECRET: 'dev-pseudonym-secret-change-me',
};

describe('loadConfig', () => {
  it('[API-34] aplica valores padrão seguros', () => {
    expect(loadConfig(valid)).toMatchObject({
      PORT: 3001,
      NODE_ENV: 'development',
      MIGRATE_ON_START: true,
      SEED_ON_START: false,
      DEMO_MODE: false,
      ORDERS_API_KEYS: [{ clientName: 'agent-service', key: 'dev-agent-key-change-me' }],
    });
  });

  it('[API-34] falha rápido listando as variáveis inválidas, sem expor valores', () => {
    const attempt = () =>
      loadConfig({ ...valid, DATABASE_URL: 'mysql://topsecret@host/db', ORDERS_API_KEYS: 'curta' });
    expect(attempt).toThrow(ConfigError);
    expect(attempt).toThrow(/DATABASE_URL/);
    expect(attempt).toThrow(/ORDERS_API_KEYS/);
    expect(attempt).not.toThrow(/topsecret/);
  });

  it('[API-35] valida o segredo de cada chave, e não a entrada inteira', () => {
    expect(() =>
      loadConfig({ ...valid, ORDERS_API_KEYS: 'agent-service-with-long-name:ab' }),
    ).toThrow(/16 caracteres/);
    expect(() => loadConfig({ ...valid, ORDERS_API_KEYS: 'segredo-sem-nome-de-cliente' })).toThrow(
      /cliente:segredo/,
    );
  });

  it('[API-36] recusa segredos de desenvolvimento em produção', () => {
    expect(() => loadConfig({ ...valid, NODE_ENV: 'production' })).toThrow(/change-me/);
    expect(
      loadConfig({
        ...valid,
        NODE_ENV: 'production',
        ORDERS_API_KEYS: 'agent-service:3f9c1d7e8a2b4c6d9e0f1a2b',
        LOG_PSEUDONYM_SECRET: '7a1e9c3b5d2f4e6a8c0b',
      }).NODE_ENV,
    ).toBe('production');
  });

  it('[API-36] impede habilitar rotas de demonstração em produção', () => {
    expect(() => loadConfig({ ...valid, NODE_ENV: 'production', DEMO_MODE: 'true' })).toThrow(
      /DEMO_MODE/,
    );
  });
});

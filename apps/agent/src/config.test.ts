import { describe, expect, it } from 'vitest';

import { ConfigError, loadConfig } from './config.js';

const base = {
  DATABASE_URL: 'postgres://agent:secret@localhost:5432/agent',
  ORDERS_API_URL: 'http://localhost:3001',
  ORDERS_API_KEY: 'dev-agent-key-change-me',
  CHANNEL_WEBHOOK_SECRET: 'dev-webhook-secret-change-me',
  LOG_PSEUDONYM_SECRET: 'dev-pseudonym-secret-change-me',
};

const production = {
  ...base,
  NODE_ENV: 'production',
  ANTHROPIC_API_KEY: 'sk-ant-test',
  ORDERS_API_KEY: 'a-real-agent-key-0123456789',
  CHANNEL_WEBHOOK_SECRET: 'a-real-webhook-secret-0123456789',
  LOG_PSEUDONYM_SECRET: 'a-real-pseudonym-secret-0123456789',
};

describe('loadConfig', () => {
  it('usa Claude Haiku 5.5 com esforço baixo por padrão', () => {
    const config = loadConfig(base);
    expect(config.LLM_MODEL).toBe('claude-haiku-5-5');
    expect(config.LLM_EFFORT).toBe('low');
    expect(config.LLM_MAX_TOKENS).toBe(8_192);
  });

  it('aceita só modelos compatíveis com a requisição do harness', () => {
    expect(loadConfig({ ...base, LLM_MODEL: 'claude-sonnet-5-5' }).LLM_MODEL).toBe(
      'claude-sonnet-5-5',
    );
    // claude-sonnet-5 não aceita mensagens de sistema no meio da conversa: toda chamada seria 400.
    expect(() => loadConfig({ ...base, LLM_MODEL: 'claude-sonnet-5' })).toThrow(ConfigError);
  });

  it('trata variável vazia (padrão do docker-compose) como ausente', () => {
    expect(loadConfig({ ...base, ANTHROPIC_API_KEY: '' }).ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('em produção, exige a chave da Anthropic e recusa segredos de desenvolvimento e modo demo', () => {
    expect(loadConfig(production).NODE_ENV).toBe('production');
    expect(() => loadConfig({ ...production, ANTHROPIC_API_KEY: '' })).toThrow(/ANTHROPIC_API_KEY/);
    expect(() => loadConfig({ ...production, ORDERS_API_KEY: base.ORDERS_API_KEY })).toThrow(
      /change-me/,
    );
    expect(() => loadConfig({ ...production, DEMO_MODE: 'true' })).toThrow(/DEMO_MODE/);
  });
});

import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createLogger } from '@agente/shared';

import { AgentService } from '../agent/agent-service.js';
import { ToolExecutor } from '../agent/tools.js';
import { InMemoryConversationStore } from '../conversation/in-memory-store.js';
import { ChaosState } from '../demo/chaos.js';
import { FakeCatalog, FakeOrdersApi, PHONES, ScriptedLlm, llm } from '../testing/fakes.js';
import { createAgentApp, signWebhook } from './agent-app.js';
import { simulatorRouter } from './simulator-routes.js';

const SECRET = 'test-webhook-secret-0001';

function setup() {
  const logger = createLogger({ service: 'agent', level: 'silent' });
  const store = new InMemoryConversationStore();
  const orders = new FakeOrdersApi();
  const model = new ScriptedLlm();
  const tools = new ToolExecutor({
    orders,
    catalog: new FakeCatalog(),
    store,
    logger,
    now: () => new Date(),
    confirmationTtlMs: 600_000,
    catalogBudgetMs: 200,
  });
  const agent = new AgentService({
    store,
    orders,
    tools,
    llm: model,
    prompt: { text: 'prompt', version: 'system-prompt@test', canary: 'CANARY-x' },
    logger,
    now: () => new Date(),
    pseudonymSecret: 'test-pseudonym-secret-0001',
    conversationIdleMs: 1_800_000,
    confirmationTtlMs: 600_000,
    maxLlmIterations: 4,
    messagesPerMinute: 50,
  });
  const chaos = new ChaosState();
  const app = createAgentApp({
    agent,
    logger,
    webhookSecret: SECRET,
    checkReadiness: () => Promise.resolve({ database: 'ok' }),
    simulatorRouter: simulatorRouter({
      agent,
      store,
      chaos,
      ordersDemo: {
        reset: () => Promise.resolve(),
        shipOrder: () => Promise.resolve({ shipped: true, status: 200 }),
      },
      info: {
        model: 'claude-haiku-5-5',
        promptVersion: 'system-prompt@test',
        llmConfigured: true,
        llmSimulated: false,
      },
    }),
  });
  return { app, model, chaos };
}

const webhook = (app: ReturnType<typeof setup>['app'], body: object, signature?: string) => {
  const raw = JSON.stringify(body);
  return request(app)
    .post('/channels/mock-whatsapp/webhook')
    .set('content-type', 'application/json')
    .set('x-signature-256', signature ?? signWebhook(raw, SECRET))
    .send(raw);
};

describe('webhook do canal de mensagens', () => {
  it('[HT-01] processa mensagem com assinatura HMAC válida', async () => {
    const { app, model } = setup();
    model.script(llm.reply('Olá! Como posso ajudar?'));
    const res = await webhook(app, { messageId: 'wamid.1', from: PHONES.ana, text: 'oi' });

    expect(res.status).toBe(200);
    expect(res.body.messages).toEqual([{ text: 'Olá! Como posso ajudar?' }]);
    expect(res.body.correlationId).toBe(res.headers['x-correlation-id']);
  });

  it('[HT-02] recusa assinatura inválida ou ausente sem processar a mensagem', async () => {
    const { app, model } = setup();
    const body = { messageId: 'wamid.2', from: PHONES.ana, text: 'cancela o 100101' };
    expect((await webhook(app, body, 'sha256=00')).status).toBe(401);
    expect((await webhook(app, body, signWebhook('{"outro":"corpo"}', SECRET))).status).toBe(401);
    expect(model.requests).toHaveLength(0);
  });

  it.each([
    [{ messageId: 'x', from: '51999', text: 'oi' }],
    [{ messageId: 'x', from: PHONES.ana }],
    [{ messageId: 'x', from: PHONES.ana, text: 'oi', admin: true }],
  ])('[HT-03] valida o payload %#', async (body) => {
    const { app } = setup();
    const res = await webhook(app, body);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('[HT-04] reentrega do mesmo webhook devolve a mesma resposta sem novo processamento', async () => {
    const { app, model } = setup();
    model.script(llm.reply('Olá!'));
    const body = { messageId: 'wamid.3', from: PHONES.ana, text: 'oi' };
    const first = await webhook(app, body);
    const second = await webhook(app, body);
    expect(second.body).toEqual(first.body);
    expect(model.requests).toHaveLength(1);
  });
});

describe('API do simulador (modo demonstração)', () => {
  it('[HT-05] liga e desliga falhas simuladas e as reflete no estado', async () => {
    const { app, chaos } = setup();
    const res = await request(app).put('/simulator/chaos').send({ ordersApiDown: true });
    expect(res.body.chaos).toEqual({ ordersApiDown: true, catalogDown: false, llmDown: false });
    expect(chaos.ordersApiDown).toBe(true);
    expect((await request(app).put('/simulator/chaos').send({ hack: true })).status).toBe(400);
  });

  it('[HT-05] envia mensagens pelo mesmo fluxo do webhook e devolve o trace do turno', async () => {
    const { app, model } = setup();
    model.script(llm.reply('Olá!'));
    const res = await request(app)
      .post('/simulator/messages')
      .send({ from: PHONES.ana, text: 'oi' });
    expect(res.body.reply.messages[0].text).toBe('Olá!');
    expect(res.body.trace).toMatchObject({ path: 'llm', responseSource: 'llm' });
  });
});

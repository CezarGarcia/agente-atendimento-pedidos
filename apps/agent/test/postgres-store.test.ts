import { randomUUID } from 'node:crypto';

import type { Kysely } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inject } from 'vitest';

import { createLogger } from '@agente/shared';

import { AgentService } from '../src/agent/agent-service.js';
import { CONFIRM_PAYLOAD_PREFIX } from '../src/agent/confirmation.js';
import { ToolExecutor } from '../src/agent/tools.js';
import type { LlmMessage } from '../src/agent/types.js';
import {
  createAgentDatabase,
  migrateAgentDatabase,
  type AgentDatabase,
} from '../src/conversation/database.js';
import { PostgresConversationStore } from '../src/conversation/postgres-store.js';
import { FakeCatalog, FakeOrdersApi, PHONES, ScriptedLlm, llm } from '../src/testing/fakes.js';

const silent = createLogger({ service: 'test', level: 'silent' });
let db: Kysely<AgentDatabase>;
let databaseName: string;

beforeAll(async () => {
  const adminUrl = inject('postgresAdminUrl');
  databaseName = `agent_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${databaseName}`);
  await admin.end();
  const url = new URL(adminUrl);
  url.pathname = `/${databaseName}`;
  db = createAgentDatabase(url.toString(), { logger: silent });
  await migrateAgentDatabase(db, silent);
});

afterAll(async () => {
  await db.destroy();
  const admin = new pg.Client({ connectionString: inject('postgresAdminUrl') });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
  await admin.end();
});

function agentWith(store: PostgresConversationStore) {
  const orders = new FakeOrdersApi();
  const model = new ScriptedLlm();
  const tools = new ToolExecutor({
    orders,
    catalog: new FakeCatalog(),
    store,
    logger: silent,
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
    logger: silent,
    now: () => new Date(),
    pseudonymSecret: 'test-pseudonym-secret-0001',
    conversationIdleMs: 1_800_000,
    confirmationTtlMs: 600_000,
    maxLlmIterations: 4,
    messagesPerMinute: 50,
  });
  return { agent, orders, model };
}

describe('PostgresConversationStore com o agente real', () => {
  it('executa o fluxo completo de cancelamento persistindo estado e histórico', async () => {
    const store = new PostgresConversationStore(db);
    const { agent, orders, model } = agentWith(store);
    model.script(
      llm.callTool('solicitar_cancelamento', { numero_pedido: '100101', motivo: 'engano' }),
    );

    const confirmation = await agent.handle({
      messageId: randomUUID(),
      from: PHONES.ana,
      text: 'cancela o 100101',
    });
    const payload = confirmation.messages[0]?.quickReplies?.[0]?.payload ?? '';
    const done = await agent.handle({
      messageId: randomUUID(),
      from: PHONES.ana,
      button: { payload, title: 'Sim, cancelar' },
    });

    expect(done.messages[0]?.text).toContain('foi cancelado');
    expect(orders.cancelCalls[0]?.idempotencyKey).toBe(payload.replace(CONFIRM_PAYLOAD_PREFIX, ''));
    const actions = await store.listPendingActions(done.conversationId);
    expect(actions.map((a) => a.status)).toEqual(['completed']);
    expect((await store.listTraces(done.conversationId, 10)).map((t) => t.path)).toEqual([
      'llm',
      'confirmation',
    ]);
  });

  it('guarda o histórico exatamente como enviado ao modelo (inclusive blocos de raciocínio)', async () => {
    const store = new PostgresConversationStore(db);
    const conversation = await store.createConversation({
      phoneRef: `tel_${randomUUID()}`,
      customerId: 'cust-ana',
      customerFirstName: 'Ana',
      identityStatus: 'verified',
    });
    const assistant: LlmMessage = {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: '', signature: 'EpQBCkYIBxgCKkA…assinatura-opaca' },
        { type: 'text', text: 'Olá! 😊' },
      ],
    };
    await store.appendMessages(conversation.id, [
      { message: { role: 'user', content: 'oi' }, kind: 'customer', displayText: 'oi' },
      { message: assistant, kind: 'agent', displayText: 'Olá! 😊' },
    ]);
    const loaded = await store.loadMessages(conversation.id);
    expect(loaded.map((m) => m.message)).toEqual([{ role: 'user', content: 'oi' }, assistant]);
  });

  it('encontra a conversa ativa pelo HMAC do telefone e respeita a inatividade', async () => {
    const store = new PostgresConversationStore(db);
    const phoneRef = `tel_${randomUUID()}`;
    const conversation = await store.createConversation({
      phoneRef,
      customerId: null,
      customerFirstName: null,
      identityStatus: 'unknown_customer',
    });
    await store.touchConversation(conversation.id, new Date(Date.now() - 3_600_000));

    expect(
      await store.findActiveConversation(phoneRef, new Date(Date.now() - 7_200_000)),
    ).not.toBeNull();
    expect(await store.findActiveConversation(phoneRef, new Date(Date.now() - 60_000))).toBeNull();
  });

  it('deduplica mensagens e mantém um único protocolo por conversa', async () => {
    const store = new PostgresConversationStore(db);
    const conversation = await store.createConversation({
      phoneRef: `tel_${randomUUID()}`,
      customerId: 'cust-ana',
      customerFirstName: 'Ana',
      identityStatus: 'verified',
    });
    const reply = {
      conversationId: conversation.id,
      correlationId: 'c-1',
      messages: [{ text: 'oi' }],
    };
    await store.saveProcessedMessage('wamid.X', reply);
    await store.saveProcessedMessage('wamid.X', reply);
    expect(await store.findProcessedMessage('wamid.X')).toEqual(reply);

    const first = await store.createHandoff({
      conversationId: conversation.id,
      reason: 'outro',
      summary: 's',
    });
    const second = await store.createHandoff({
      conversationId: conversation.id,
      reason: 'outro',
      summary: 's',
    });
    expect(second.protocol).toBe(first.protocol);
  });
});

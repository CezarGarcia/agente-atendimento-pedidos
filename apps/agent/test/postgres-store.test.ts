import { randomUUID } from 'node:crypto';

import type { Kysely } from 'kysely';
import { Migrator } from 'kysely/migration';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { inject } from 'vitest';

import { createLogger } from '@agente/shared';

import { AgentService } from '../src/agent/agent-service.js';
import { CONFIRM_PAYLOAD_PREFIX } from '../src/agent/confirmation.js';
import { ToolExecutor } from '../src/agent/tools.js';
import type { LlmMessage, TurnTrace } from '../src/agent/types.js';
import {
  AGENT_MIGRATIONS,
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
  it('[PG-01] executa o fluxo completo de cancelamento persistindo estado e histórico', async () => {
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

  const newConversation = (store: PostgresConversationStore) =>
    store.createConversation({
      phoneRef: `tel_${randomUUID()}`,
      customerId: 'cust-ana',
      customerFirstName: 'Ana',
      identityStatus: 'verified',
      llmProfile: 'system-prompt@test|claude-haiku-5-5',
    });

  const trace = (conversationId: string): TurnTrace => ({
    correlationId: randomUUID(),
    conversationId,
    startedAt: new Date().toISOString(),
    durationMs: 1,
    promptVersion: 'system-prompt@test',
    path: 'llm',
    inputGuard: { piiDetected: [], injectionSignals: [], truncated: false },
    llmCalls: [],
    toolCalls: [],
    responseSource: 'llm',
  });

  it('[PG-02] guarda o histórico exatamente como enviado ao modelo (inclusive blocos de raciocínio)', async () => {
    const store = new PostgresConversationStore(db);
    const conversation = await newConversation(store);
    const assistant: LlmMessage = {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: '', signature: 'EpQBCkYIBxgCKkA…assinatura-opaca' },
        { type: 'text', text: 'Olá! 😊' },
      ],
    };
    const key = `tel:${randomUUID()}`;
    await store.claimMessage(key);
    await store.completeTurn({
      messageKey: key,
      conversationId: conversation.id,
      messages: [
        { message: { role: 'user', content: 'oi' }, kind: 'customer', displayText: 'oi' },
        { message: assistant, kind: 'agent', displayText: 'Olá! 😊' },
      ],
      at: new Date(),
      trace: trace(conversation.id),
      reply: {
        conversationId: conversation.id,
        correlationId: 'c',
        messages: [{ text: 'Olá! 😊' }],
      },
    });
    const loaded = await store.loadMessages(conversation.id);
    expect(loaded.map((m) => m.message)).toEqual([{ role: 'user', content: 'oi' }, assistant]);
  });

  it('[PG-03] encontra a conversa ativa pelo HMAC do telefone e respeita a inatividade', async () => {
    const store = new PostgresConversationStore(db);
    const conversation = await newConversation(store);
    await db
      .updateTable('conversations')
      .set({ last_activity_at: new Date(Date.now() - 3_600_000) })
      .where('id', '=', conversation.id)
      .execute();

    const phoneRef = conversation.phoneRef;
    expect(
      await store.findActiveConversation(phoneRef, new Date(Date.now() - 7_200_000)),
    ).not.toBeNull();
    expect(await store.findActiveConversation(phoneRef, new Date(Date.now() - 60_000))).toBeNull();
  });

  it('[PG-04] reserva cada mensagem uma única vez e devolve a resposta gravada nas repetições', async () => {
    const store = new PostgresConversationStore(db);
    const conversation = await newConversation(store);
    const key = `tel:${randomUUID()}`;
    const claims = await Promise.all([store.claimMessage(key), store.claimMessage(key)]);
    expect(claims.filter((c) => c.status === 'claimed')).toHaveLength(1);
    expect(claims.find((c) => c.status === 'duplicate')).toEqual({
      status: 'duplicate',
      reply: null,
    });

    const reply = {
      conversationId: conversation.id,
      correlationId: 'c-1',
      messages: [{ text: 'oi' }],
    };
    await store.completeTurn({
      messageKey: key,
      conversationId: conversation.id,
      messages: [],
      at: new Date(),
      trace: trace(conversation.id),
      reply,
    });
    expect(await store.claimMessage(key)).toEqual({ status: 'duplicate', reply });
  });

  it('[PG-04] retoma a reserva abandonada (processo caiu antes de responder)', async () => {
    const store = new PostgresConversationStore(db);
    const key = `tel:${randomUUID()}`;
    await store.claimMessage(key);
    await db
      .updateTable('processed_messages')
      .set({ claimed_at: new Date(Date.now() - 5 * 60_000) })
      .where('message_id', '=', key)
      .execute();
    expect(await store.claimMessage(key)).toEqual({ status: 'claimed' });
  });

  it('[PG-05] transição de ação pendente é atômica: confirmação e recusa simultâneas, só uma vence', async () => {
    const store = new PostgresConversationStore(db);
    const conversation = await newConversation(store);
    const id = randomUUID();
    await store.savePendingAction({
      id,
      conversationId: conversation.id,
      type: 'cancel_order',
      orderId: '100101',
      reason: null,
      orderSummary: '1 item, total R$ 1,00',
      status: 'awaiting_confirmation',
      awaitingTextReply: true,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 600_000),
    });
    const open = ['awaiting_confirmation', 'outcome_unknown'] as const;
    const results = await Promise.all([
      store.transitionPendingAction(id, open, 'executing'),
      store.transitionPendingAction(id, open, 'declined'),
      store.transitionPendingAction(id, open, 'executing'),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await store.findOpenPendingAction(conversation.id)).toBeNull();
  });

  it('[PG-07] o banco recusa uma segunda ação aberta na mesma conversa (várias instâncias)', async () => {
    const store = new PostgresConversationStore(db);
    const conversation = await newConversation(store);
    const action = (orderId: string) => ({
      id: randomUUID(),
      conversationId: conversation.id,
      type: 'cancel_order' as const,
      orderId,
      reason: null,
      orderSummary: '1 item, total R$ 1,00',
      status: 'awaiting_confirmation' as const,
      awaitingTextReply: true,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 600_000),
    });
    await store.savePendingAction(action('100101'));
    await expect(store.savePendingAction(action('100103'))).rejects.toThrow();
    expect((await store.findOpenPendingAction(conversation.id))?.orderId).toBe('100101');
  });

  it('[PG-08] duas instâncias: um cancelamento em execução não perde o resultado incerto', async () => {
    const store = new PostgresConversationStore(db);
    const first = agentWith(store);
    const second = agentWith(store);
    // A API da instância A demora e devolve erro técnico (resultado incerto).
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    first.orders.requestCancellation = async () => {
      await gate;
      return { kind: 'technical_error', reason: 'timeout' };
    };
    first.model.script(
      llm.callTool('solicitar_cancelamento', { numero_pedido: '100101', motivo: null }),
    );
    second.orders.setStatus('100103', 'PROCESSING');
    second.model.script(
      llm.callTool('solicitar_cancelamento', { numero_pedido: '100103', motivo: null }),
      llm.reply('Já tem um pedido seu sendo processado; te aviso do resultado em instantes.'),
    );
    const phone = PHONES.ana;
    await first.agent.endConversation(phone); // conversa nova, sem ações de outros testes

    const question = await first.agent.handle({
      messageId: 'race-1',
      from: phone,
      text: 'cancela o 100101',
    });
    const payload = question.messages[0]?.quickReplies?.[0]?.payload ?? '';
    const confirming = first.agent.handle({
      messageId: 'race-2',
      from: phone,
      button: { payload, title: 'Sim, cancelar' },
    });
    await vi.waitFor(async () => {
      const actions = await store.listPendingActions(question.conversationId);
      expect(actions.map((a) => a.status)).toContain('executing');
    });
    const other = await second.agent.handle({
      messageId: 'race-3',
      from: phone,
      text: 'e o 100103?',
    });
    release();
    const result = await confirming;

    expect(other.messages[0]?.quickReplies).toBeUndefined();
    expect(result.messages[0]?.text).toContain('não consegui confirmar');
    const actions = await store.listPendingActions(question.conversationId);
    expect(actions.map((a) => `${a.orderId}:${a.status}`)).toEqual(['100101:outcome_unknown']);
  });

  it('[PG-09] migration 0004 sobre dados antigos: a ação em execução segue, a outra perde a vez', async () => {
    const adminUrl = inject('postgresAdminUrl');
    const name = `agent_mig_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(adminUrl);
    url.pathname = `/${name}`;
    const oldDb = createAgentDatabase(url.toString(), { logger: silent });
    try {
      const migrator = new Migrator({
        db: oldDb,
        provider: { getMigrations: () => Promise.resolve(AGENT_MIGRATIONS) },
      });
      expect((await migrator.migrateTo('0003-one-open-action')).error).toBeUndefined();
      const conversation = await new PostgresConversationStore(oldDb).createConversation({
        phoneRef: 'tel_migracao',
        customerId: null,
        customerFirstName: null,
        identityStatus: 'unknown_customer',
        llmProfile: 'perfil',
      });
      const row = (orderId: string, status: string) => ({
        id: randomUUID(),
        conversation_id: conversation.id,
        type: 'cancel_order',
        order_id: orderId,
        reason: null,
        order_summary: '1 item, total R$ 1,00',
        status,
        awaiting_text_reply: true,
        created_at: new Date(),
        expires_at: new Date(Date.now() + 600_000),
        updated_at: new Date(),
      });
      // Estado que a 0003 permitia: uma em execução e outra aberta na mesma conversa.
      await oldDb
        .insertInto('pending_actions')
        .values([row('100101', 'executing'), row('100103', 'awaiting_confirmation')])
        .execute();

      expect((await migrator.migrateToLatest()).error).toBeUndefined();
      const store = new PostgresConversationStore(oldDb);
      const statuses = (await store.listPendingActions(conversation.id)).map(
        (a) => `${a.orderId}:${a.status}`,
      );
      expect(statuses.sort()).toEqual(['100101:executing', '100103:superseded']);
      // Daqui em diante o banco recusa abrir outra enquanto uma está em execução.
      await expect(
        oldDb
          .insertInto('pending_actions')
          .values(row('100103', 'awaiting_confirmation'))
          .execute(),
      ).rejects.toThrow();
    } finally {
      await oldDb.destroy();
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.end();
    }
  });

  it('[PG-06] mantém um único protocolo de atendimento por conversa', async () => {
    const store = new PostgresConversationStore(db);
    const conversation = await newConversation(store);
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

import {
  Kysely,
  PostgresDialect,
  type ColumnType,
  type Generated,
  type JSONColumnType,
} from 'kysely';
import { Migrator, type Migration } from 'kysely/migration';
import pg from 'pg';

import type { Logger } from '@agente/shared';

import type { AgentReply, LlmMessage, TurnTrace } from '../agent/types.js';
import * as initialSchema from './migrations/0001-initial-schema.js';
import * as reviewHardening from './migrations/0002-review-hardening.js';

type Timestamp = ColumnType<Date, Date | string, Date | string>;

export interface AgentDatabase {
  conversations: {
    id: Generated<string>;
    phone_ref: string;
    customer_id: string | null;
    customer_first_name: string | null;
    identity_status: string;
    llm_profile: string;
    status: Generated<string>;
    created_at: Generated<Date>;
    last_activity_at: Timestamp;
  };
  conversation_messages: {
    id: Generated<string>;
    conversation_id: string;
    kind: string;
    payload: JSONColumnType<LlmMessage>;
    display_text: string | null;
    created_at: Generated<Date>;
  };
  pending_actions: {
    id: string;
    conversation_id: string;
    type: string;
    order_id: string;
    reason: string | null;
    order_summary: string;
    status: string;
    awaiting_text_reply: boolean;
    created_at: Timestamp;
    expires_at: Timestamp;
    updated_at: Timestamp;
  };
  handoffs: {
    protocol: string;
    conversation_id: string;
    reason: string;
    summary: string;
    created_at: Generated<Date>;
  };
  processed_messages: {
    message_id: string;
    conversation_id: string | null;
    reply: JSONColumnType<AgentReply | null, string | null, string | null>;
    created_at: Generated<Date>;
    claimed_at: Generated<Date>;
  };
  turn_traces: {
    id: Generated<string>;
    conversation_id: string;
    correlation_id: string;
    trace: JSONColumnType<TurnTrace>;
    created_at: Generated<Date>;
  };
}

export function createAgentDatabase(
  connectionString: string,
  options: { logger: Logger; maxConnections?: number },
): Kysely<AgentDatabase> {
  const pool = new pg.Pool({
    connectionString,
    max: options.maxConnections ?? 10,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 10_000,
    application_name: 'agent',
  });
  pool.on('error', (error: Error & { code?: string }) => {
    options.logger.warn(
      { event: 'db.pool.idle_client_error', code: error.code },
      'conexão ociosa com o banco foi encerrada; será recriada',
    );
  });
  return new Kysely<AgentDatabase>({ dialect: new PostgresDialect({ pool }) });
}

const migrations: Record<string, Migration> = {
  '0001-initial-schema': initialSchema,
  '0002-review-hardening': reviewHardening,
};

export async function migrateAgentDatabase(
  db: Kysely<AgentDatabase>,
  logger: Logger,
): Promise<void> {
  const migrator = new Migrator({
    db,
    provider: { getMigrations: () => Promise.resolve(migrations) },
  });
  const { error, results } = await migrator.migrateToLatest();
  for (const result of results ?? []) {
    logger.info(
      { event: 'db.migration', migration: result.migrationName, status: result.status },
      'migration executada',
    );
  }
  if (error) throw error instanceof Error ? error : new Error('Falha ao executar migrations');
}

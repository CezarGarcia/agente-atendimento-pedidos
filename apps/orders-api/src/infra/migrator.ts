import type { Kysely } from 'kysely';
import { Migrator } from 'kysely/migration';

import type { Logger } from '@agente/shared';

import type { Database } from './database.js';
import { migrationProvider } from './migrations/index.js';

export async function migrateToLatest(db: Kysely<Database>, logger: Logger): Promise<void> {
  const migrator = new Migrator({ db, provider: migrationProvider });
  const { error, results } = await migrator.migrateToLatest();

  for (const result of results ?? []) {
    logger.info(
      { event: 'db.migration', migration: result.migrationName, status: result.status },
      'migration executada',
    );
  }
  if (error) {
    throw error instanceof Error ? error : new Error('Falha ao executar migrations');
  }
}

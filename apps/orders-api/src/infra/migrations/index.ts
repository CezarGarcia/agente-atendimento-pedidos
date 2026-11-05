import type { Migration, MigrationProvider } from 'kysely/migration';

import * as initialSchema from './0001-initial-schema.js';

/**
 * Migrations registradas em código (e não lidas do disco) para funcionarem igual no
 * código-fonte, nos testes e no bundle de produção.
 */
const migrations: Record<string, Migration> = {
  '0001-initial-schema': initialSchema,
};

export const migrationProvider: MigrationProvider = {
  getMigrations: () => Promise.resolve(migrations),
};

import { createLogger } from '@agente/shared';

import { loadConfig } from '../config.js';
import { createDatabase } from '../infra/database.js';
import { migrateToLatest } from '../infra/migrator.js';

const config = loadConfig();
const db = createDatabase(config.DATABASE_URL, 1);
try {
  await migrateToLatest(
    db,
    createLogger({ service: 'orders-api-migrate', level: config.LOG_LEVEL }),
  );
} finally {
  await db.destroy();
}

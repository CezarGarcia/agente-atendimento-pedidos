import { createLogger } from '@agente/shared';

import { loadConfig } from '../config.js';
import { createDatabase } from '../infra/database.js';
import { resetDemoData } from '../infra/seed.js';

/** Recria os dados de demonstração (apaga os pedidos existentes). */
const config = loadConfig();
const logger = createLogger({ service: 'orders-api-seed' });
const db = createDatabase(config.DATABASE_URL, { logger, maxConnections: 1 });
try {
  await resetDemoData(db);
  logger.info({ event: 'db.seeded' }, 'dados recriados');
} finally {
  await db.destroy();
}

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { buildOpenApiDocument } from '../http/openapi.js';

/** Exporta o contrato para docs/, permitindo consultá-lo sem subir a API. */
const target = resolve(import.meta.dirname, '../../../../docs/api/openapi.json');
writeFileSync(target, `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`);
process.stdout.write(`OpenAPI exportado para ${target}\n`);

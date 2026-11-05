import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

// Habilita `.openapi()` nos schemas Zod: a mesma definição valida a entrada e gera a documentação.
extendZodWithOpenApi(z);

export { z };

import { OpenAPIRegistry, OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi';

import {
  CancellationRequestSchema,
  CancellationResultSchema,
  CustomerLookupRequestSchema,
  CustomerLookupResultSchema,
  CustomerOrderParamsSchema,
  CustomerParamsSchema,
  IdempotencyKeySchema,
  ListOrdersQuerySchema,
  OrderListSchema,
  OrderNotCancellableProblemSchema,
  OrderSchema,
  ProblemSchema,
  ValidationProblemSchema,
} from './schemas.js';
import { z } from './zod.js';

const json = <T extends z.ZodType>(schema: T) => ({ 'application/json': { schema } });
const problem = <T extends z.ZodType>(schema: T) => ({ 'application/problem+json': { schema } });

const commonErrors = {
  400: {
    description: 'Entrada inválida (`VALIDATION_ERROR`).',
    content: problem(ValidationProblemSchema),
  },
  401: {
    description: 'Chave de API ausente ou inválida (`UNAUTHENTICATED`).',
    content: problem(ProblemSchema),
  },
  429: {
    description: 'Limite de requisições excedido (`RATE_LIMITED`).',
    content: problem(ProblemSchema),
  },
  500: { description: 'Erro técnico (`INTERNAL_ERROR`).', content: problem(ProblemSchema) },
  503: {
    description: 'Dependência indisponível (`SERVICE_UNAVAILABLE`). Pode ser repetida.',
    content: problem(ProblemSchema),
  },
};

const CorrelationHeaderSchema = z.object({
  'x-correlation-id': z.string().optional().openapi({
    description: 'Identificador de correlação propagado entre serviços (gerado se ausente).',
  }),
});

const DESCRIPTION = `
API principal de pedidos. É a **fonte da verdade** do status dos pedidos e das regras de
cancelamento: o agente de IA consulta e solicita, mas quem decide é esta API.

### Regras aplicadas
- Um pedido só pode ser cancelado enquanto está \`PROCESSING\` (em processamento).
- Pedidos enviados, entregues, já cancelados ou aguardando pagamento **não** são cancelados
  pelo fluxo automatizado (\`409 ORDER_NOT_CANCELLABLE\`, com o motivo em \`reason\`).
- Toda consulta é escopada pelo cliente. Pedido de outro cliente responde \`404\`, igual a um
  pedido inexistente, para não revelar que ele existe.
- O cancelamento exige \`Idempotency-Key\`: repetir a mesma chave devolve o resultado original
  sem executar a ação duas vezes.

### Como distinguir os resultados
| Resultado | HTTP | \`code\` |
| --- | --- | --- |
| Sucesso | 200 | — |
| Pedido não encontrado | 404 | \`ORDER_NOT_FOUND\` |
| Pedido não cancelável | 409 | \`ORDER_NOT_CANCELLABLE\` |
| Erro técnico | 500 / 503 | \`INTERNAL_ERROR\` / \`SERVICE_UNAVAILABLE\` |

Para testar por aqui, clique em **Authorize** e informe a chave de desenvolvimento
\`dev-swagger-key-change-me\` (configurada no docker-compose).
`;

export function buildOpenApiDocument(): ReturnType<OpenApiGeneratorV31['generateDocument']> {
  const registry = new OpenAPIRegistry();

  const apiKey = registry.registerComponent('securitySchemes', 'ApiKeyAuth', {
    type: 'apiKey',
    in: 'header',
    name: 'x-api-key',
    description: 'Chave de serviço (autenticação serviço-a-serviço).',
  });
  const security = [{ [apiKey.name]: [] }];

  registry.registerPath({
    method: 'post',
    path: '/v1/customers/lookup',
    tags: ['Clientes'],
    summary: 'Identificar cliente pelo telefone do canal',
    description: 'Retorna apenas o identificador e o primeiro nome (minimização de dados).',
    security,
    request: {
      headers: CorrelationHeaderSchema,
      body: { content: json(CustomerLookupRequestSchema), required: true },
    },
    responses: {
      200: { description: 'Cliente identificado.', content: json(CustomerLookupResultSchema) },
      404: {
        description: 'Telefone não cadastrado (`CUSTOMER_NOT_FOUND`).',
        content: problem(ProblemSchema),
      },
      ...commonErrors,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/customers/{customerId}/orders',
    tags: ['Pedidos'],
    summary: 'Listar pedidos recentes do cliente',
    security,
    request: {
      params: CustomerParamsSchema,
      query: ListOrdersQuerySchema,
      headers: CorrelationHeaderSchema,
    },
    responses: {
      200: {
        description: 'Pedidos do cliente, do mais recente ao mais antigo.',
        content: json(OrderListSchema),
      },
      ...commonErrors,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/customers/{customerId}/orders/{orderId}',
    tags: ['Pedidos'],
    summary: 'Consultar um pedido',
    description:
      'Inclui `cancellation.eligible`, calculado pelo domínio. A regra é reavaliada no momento ' +
      'do cancelamento, então este campo é informativo.',
    security,
    request: { params: CustomerOrderParamsSchema, headers: CorrelationHeaderSchema },
    responses: {
      200: { description: 'Pedido encontrado.', content: json(OrderSchema) },
      404: {
        description: 'Pedido inexistente ou de outro cliente (`ORDER_NOT_FOUND`).',
        content: problem(ProblemSchema),
      },
      ...commonErrors,
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/v1/customers/{customerId}/orders/{orderId}/cancellation',
    tags: ['Pedidos'],
    summary: 'Solicitar o cancelamento de um pedido',
    description:
      'Cancela o pedido somente se ele estiver em processamento. A verificação e a mudança de ' +
      'status acontecem na mesma transação, com bloqueio do pedido: duas solicitações ' +
      'simultâneas nunca cancelam duas vezes.',
    security,
    request: {
      params: CustomerOrderParamsSchema,
      headers: CorrelationHeaderSchema.extend({ 'idempotency-key': IdempotencyKeySchema }),
      body: { content: json(CancellationRequestSchema), required: false },
    },
    responses: {
      200: {
        description:
          'Pedido cancelado. O header `Idempotent-Replayed: true` indica resposta repetida.',
        content: json(CancellationResultSchema),
      },
      404: {
        description: 'Pedido inexistente ou de outro cliente (`ORDER_NOT_FOUND`).',
        content: problem(ProblemSchema),
      },
      409: {
        description: 'Pedido não pode ser cancelado (`ORDER_NOT_CANCELLABLE`).',
        content: problem(OrderNotCancellableProblemSchema),
      },
      422: {
        description: 'Idempotency-Key reutilizada com outro corpo (`IDEMPOTENCY_KEY_MISMATCH`).',
        content: problem(ProblemSchema),
      },
      ...commonErrors,
    },
  });

  return new OpenApiGeneratorV31(registry.definitions).generateDocument({
    openapi: '3.1.0',
    info: { title: 'API de Pedidos', version: '1.0.0', description: DESCRIPTION.trim() },
    servers: [{ url: '/', description: 'Servidor atual' }],
    tags: [
      { name: 'Clientes', description: 'Identificação do cliente a partir do canal de mensagens.' },
      { name: 'Pedidos', description: 'Consulta e cancelamento de pedidos.' },
    ],
  });
}

import {
  MAX_CANCELLATION_REASON_LENGTH,
  ORDER_ID_PATTERN,
  ORDER_STATUSES,
} from '../domain/order.js';
import { PROBLEM_CODES } from './problem.js';
import { z } from './zod.js';

/*
 * Fonte única de verdade do contrato HTTP: estes schemas validam as requisições em tempo de
 * execução E geram o documento OpenAPI servido em /docs.
 * Entradas usam objetos estritos: campos desconhecidos são rejeitados (evita mass assignment).
 */

// ---------- Parâmetros e entradas ----------

export const CustomerIdSchema = z.uuid('customerId deve ser um UUID').openapi({
  description: 'Identificador interno do cliente (obtido em POST /v1/customers/lookup).',
  example: '11111111-1111-4111-8111-111111111111',
});

export const OrderIdSchema = z
  .string()
  .regex(ORDER_ID_PATTERN, 'orderId deve conter exatamente 6 dígitos')
  .openapi({ description: 'Número público do pedido (6 dígitos).', example: '100101' });

export const CustomerParamsSchema = z.object({ customerId: CustomerIdSchema });

export const CustomerOrderParamsSchema = z.object({
  customerId: CustomerIdSchema,
  orderId: OrderIdSchema,
});

export const ListOrdersQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(20).default(5).openapi({
    description: 'Quantidade máxima de pedidos, do mais recente para o mais antigo.',
    example: 5,
  }),
});

export const IdempotencyKeySchema = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/, 'Idempotency-Key contém caracteres inválidos')
  .openapi({
    description:
      'Chave única por tentativa lógica de cancelamento (ex.: uma confirmação do cliente). ' +
      'Reutilize-a somente para repetir a MESMA requisição após timeout ou falha de rede: a ' +
      'resposta original é devolvida sem executar a ação de novo. Válida por 24 horas.',
    example: 'pending-6b0e3f2a-9d1c-4c55-8f5e-2a7d1b9c0e41',
  });

export const CancellationRequestSchema = z
  .strictObject({
    reason: z.string().trim().min(1).max(MAX_CANCELLATION_REASON_LENGTH).optional().openapi({
      description: 'Motivo informado pelo cliente (opcional).',
      example: 'Comprei o tamanho errado',
    }),
  })
  .openapi('CancellationRequest');

export const CustomerLookupRequestSchema = z
  .strictObject({
    phone: z
      .string()
      .regex(/^\+[1-9]\d{7,14}$/, 'phone deve estar no formato E.164 (ex.: +5551990000001)')
      .openapi({
        description: 'Telefone verificado pelo canal de mensagens.',
        example: '+5551990000001',
      }),
  })
  .openapi('CustomerLookupRequest');

// ---------- Saídas ----------

export const OrderStatusSchema = z.enum(ORDER_STATUSES).openapi('OrderStatus', {
  description:
    'AWAITING_PAYMENT: aguardando pagamento · PROCESSING: em processamento (único status ' +
    'cancelável) · SHIPPED: enviado · DELIVERED: entregue · CANCELLED: cancelado',
});

export const CancellationBlockReasonSchema = z
  .enum([
    'PAYMENT_PENDING',
    'ALREADY_SHIPPED',
    'ALREADY_DELIVERED',
    'ALREADY_CANCELLED',
    'UNKNOWN_STATUS',
  ])
  .openapi('CancellationBlockReason', {
    description: 'Motivo pelo qual o pedido não pode ser cancelado pelo fluxo automatizado.',
  });

export const MoneySchema = z
  .object({
    amountCents: z.int().openapi({ example: 54990 }),
    currency: z.literal('BRL'),
    formatted: z.string().openapi({
      description:
        'Valor formatado para exibição. Evita que consumidores (inclusive o modelo de IA) façam contas.',
      example: 'R$ 549,90',
    }),
  })
  .openapi('Money');

export const OrderItemSchema = z
  .object({
    productId: z.int().openapi({
      description: 'Identificador do produto no catálogo externo (Fake Store API).',
      example: 1,
    }),
    quantity: z.int().min(1).openapi({ example: 1 }),
    unitPrice: MoneySchema,
    subtotal: MoneySchema,
  })
  .openapi('OrderItem');

export const OrderSchema = z
  .object({
    id: OrderIdSchema,
    status: OrderStatusSchema,
    placedAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    items: z.array(OrderItemSchema),
    total: MoneySchema,
    shipping: z.object({
      trackingCode: z.string().nullable(),
      estimatedDeliveryDate: z.iso.date().nullable(),
      shippedAt: z.iso.datetime().nullable(),
      deliveredAt: z.iso.datetime().nullable(),
    }),
    cancellation: z
      .object({
        eligible: z.boolean().openapi({
          description:
            'Se o pedido pode ser cancelado agora. A regra é reavaliada no momento do cancelamento.',
        }),
        blockedReason: CancellationBlockReasonSchema.nullable(),
        cancelledAt: z.iso.datetime().nullable(),
      })
      .openapi({ description: 'Situação de cancelamento calculada pelo domínio.' }),
  })
  .openapi('Order');

export const OrderSummarySchema = z
  .object({
    id: OrderIdSchema,
    status: OrderStatusSchema,
    placedAt: z.iso.datetime(),
    total: MoneySchema,
    itemCount: z.int(),
  })
  .openapi('OrderSummary');

export const OrderListSchema = z
  .object({ orders: z.array(OrderSummarySchema) })
  .openapi('OrderList');

export const CancellationResultSchema = z
  .object({ order: OrderSchema })
  .openapi('CancellationResult');

export const CustomerLookupResultSchema = z
  .object({
    customerId: CustomerIdSchema,
    firstName: z.string().openapi({
      description: 'Apenas o primeiro nome (minimização de dados).',
      example: 'Ana',
    }),
  })
  .openapi('CustomerLookupResult');

const problemCodes = Object.keys(PROBLEM_CODES) as [
  keyof typeof PROBLEM_CODES,
  ...(keyof typeof PROBLEM_CODES)[],
];

export const ProblemSchema = z
  .object({
    type: z.string().openapi({ example: '/problems/order-not-found' }),
    title: z.string().openapi({ example: 'Pedido não encontrado' }),
    status: z.int().openapi({ example: 404 }),
    code: z.enum(problemCodes),
    detail: z.string().optional(),
    instance: z.string().optional(),
    correlationId: z.string().optional(),
  })
  .openapi('Problem', {
    description:
      'Erro no formato RFC 9457 (application/problem+json). Use `code` para decidir o tratamento.',
  });

export const ValidationProblemSchema = ProblemSchema.extend({
  errors: z
    .array(z.object({ path: z.string(), message: z.string() }))
    .optional()
    .openapi({ description: 'Presente quando campos específicos falharam na validação.' }),
}).openapi('ValidationProblem');

export const OrderNotCancellableProblemSchema = ProblemSchema.extend({
  orderId: OrderIdSchema,
  currentStatus: OrderStatusSchema,
  reason: CancellationBlockReasonSchema,
}).openapi('OrderNotCancellableProblem');

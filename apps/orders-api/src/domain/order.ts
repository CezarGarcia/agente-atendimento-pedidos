/**
 * Domínio de pedidos: tipos e regras de negócio puras (sem I/O).
 *
 * Esta é a fonte da verdade da regra de cancelamento. O agente de IA pode antecipá-la para
 * conversar melhor com o cliente, mas quem decide é sempre este módulo, executado pela API.
 */

export const ORDER_STATUSES = [
  'AWAITING_PAYMENT',
  'PROCESSING',
  'SHIPPED',
  'DELIVERED',
  'CANCELLED',
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const CURRENCY = 'BRL';

/** Número público do pedido: 6 dígitos (ex.: 100101). */
export const ORDER_ID_PATTERN = /^\d{6}$/;

export const MAX_CANCELLATION_REASON_LENGTH = 500;

export interface OrderItem {
  /** Identificador do produto no catálogo externo (Fake Store API). */
  readonly productId: number;
  readonly quantity: number;
  /** Preço unitário congelado no momento da compra. Prevalece sobre qualquer preço de catálogo. */
  readonly unitPriceCents: number;
}

export interface Order {
  readonly id: string;
  readonly customerId: string;
  readonly status: OrderStatus;
  readonly items: readonly OrderItem[];
  readonly totalCents: number;
  readonly trackingCode: string | null;
  /** Data no formato ISO (AAAA-MM-DD). */
  readonly estimatedDeliveryDate: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly shippedAt: Date | null;
  readonly deliveredAt: Date | null;
  readonly cancelledAt: Date | null;
  readonly cancellationReason: string | null;
}

export interface Customer {
  readonly id: string;
  readonly fullName: string;
}

export const CANCELLATION_BLOCK_REASONS = [
  'PAYMENT_PENDING',
  'ALREADY_SHIPPED',
  'ALREADY_DELIVERED',
  'ALREADY_CANCELLED',
  'UNKNOWN_STATUS',
] as const;

export type CancellationBlockReason = (typeof CANCELLATION_BLOCK_REASONS)[number];

export type CancellationEligibility =
  | { readonly eligible: true }
  | { readonly eligible: false; readonly reason: CancellationBlockReason };

/**
 * Regras 2 e 3: um pedido só pode ser cancelado enquanto estiver em processamento.
 *
 * O mapa é exaustivo por tipo (Record<OrderStatus, …>): ao criar um status novo, o código não
 * compila até alguém decidir explicitamente se ele é cancelável. Em tempo de execução, qualquer
 * status desconhecido é negado (allowlist, não denylist).
 */
const CANCELLATION_RULES: Readonly<Record<OrderStatus, CancellationEligibility>> = {
  PROCESSING: { eligible: true },
  AWAITING_PAYMENT: { eligible: false, reason: 'PAYMENT_PENDING' },
  SHIPPED: { eligible: false, reason: 'ALREADY_SHIPPED' },
  DELIVERED: { eligible: false, reason: 'ALREADY_DELIVERED' },
  CANCELLED: { eligible: false, reason: 'ALREADY_CANCELLED' },
};

export function isOrderStatus(value: string): value is OrderStatus {
  return (ORDER_STATUSES as readonly string[]).includes(value);
}

export function evaluateCancellation(status: string): CancellationEligibility {
  return isOrderStatus(status)
    ? CANCELLATION_RULES[status]
    : { eligible: false, reason: 'UNKNOWN_STATUS' };
}

export type CancelOrderResult =
  | { readonly ok: true; readonly order: Order }
  | { readonly ok: false; readonly reason: CancellationBlockReason };

/** Transição de estado pura: devolve o pedido cancelado ou o motivo do bloqueio. */
export function cancelOrder(order: Order, now: Date, reason: string | null): CancelOrderResult {
  const eligibility = evaluateCancellation(order.status);
  if (!eligibility.eligible) {
    return { ok: false, reason: eligibility.reason };
  }
  return {
    ok: true,
    order: {
      ...order,
      status: 'CANCELLED',
      cancelledAt: now,
      updatedAt: now,
      cancellationReason: reason,
      // Pedido cancelado não tem mais previsão de entrega (evita informar uma data inválida).
      estimatedDeliveryDate: null,
    },
  };
}

export function firstName(fullName: string): string {
  return fullName.trim().split(/\s+/)[0] ?? '';
}

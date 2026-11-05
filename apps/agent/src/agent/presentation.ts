/** Rótulos e formatos em português usados nas respostas e nos dados entregues ao modelo. */

export const STATUS_LABEL: Readonly<Record<string, string>> = {
  AWAITING_PAYMENT: 'aguardando pagamento',
  PROCESSING: 'em processamento',
  SHIPPED: 'enviado',
  DELIVERED: 'entregue',
  CANCELLED: 'cancelado',
};

export const BLOCK_REASON_LABEL: Readonly<Record<string, string>> = {
  PAYMENT_PENDING: 'o pedido ainda aguarda pagamento; o cancelamento por este canal não se aplica',
  ALREADY_SHIPPED: 'o pedido já foi enviado',
  ALREADY_DELIVERED: 'o pedido já foi entregue',
  ALREADY_CANCELLED: 'o pedido já está cancelado',
  UNKNOWN_STATUS: 'a situação atual do pedido não permite cancelamento por este canal',
};

export const statusLabel = (status: string): string => STATUS_LABEL[status] ?? 'em atualização';

const TIME_ZONE = 'America/Sao_Paulo';

const dateFormatter = new Intl.DateTimeFormat('pt-BR', {
  timeZone: TIME_ZONE,
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});

/** Aceita data-hora ISO ou data pura (AAAA-MM-DD, sem conversão de fuso). */
export function formatDate(value: string | null): string | null {
  if (value === null) return null;
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (dateOnly) return `${dateOnly[3]}/${dateOnly[2]}/${dateOnly[1]}`;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : dateFormatter.format(date);
}

const nowFormatter = new Intl.DateTimeFormat('pt-BR', {
  timeZone: TIME_ZONE,
  weekday: 'long',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

export const formatNow = (now: Date): string => `${nowFormatter.format(now)} (horário de Brasília)`;

export const formatTime = (date: Date): string =>
  new Intl.DateTimeFormat('pt-BR', {
    timeZone: TIME_ZONE,
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);

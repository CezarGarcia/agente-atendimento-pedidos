import { createHmac, randomUUID } from 'node:crypto';

/** Endereços e segredos da stack local (valores padrão do docker-compose). */
export const STACK = {
  agentUrl: process.env['E2E_AGENT_URL'] ?? 'http://localhost:3002',
  ordersUrl: process.env['E2E_ORDERS_URL'] ?? 'http://localhost:3001',
  webhookSecret: process.env['CHANNEL_WEBHOOK_SECRET'] ?? 'dev-webhook-secret-change-me',
  ordersKey: process.env['SWAGGER_ORDERS_API_KEY'] ?? 'dev-swagger-key-change-me',
};

export const PERSONAS = {
  ana: { phone: '+5551990000001', customerId: '11111111-1111-4111-8111-111111111111' },
  bruno: { phone: '+5551990000002', customerId: '22222222-2222-4222-8222-222222222222' },
  carla: { phone: '+5551990000003', customerId: '33333333-3333-4333-8333-333333333333' },
  unknown: { phone: '+5511900000000', customerId: '' },
} as const;

export interface AgentReply {
  conversationId: string;
  correlationId: string;
  messages: { text: string; quickReplies?: { payload: string; title: string }[] }[];
}

export const sign = (raw: string, secret = STACK.webhookSecret): string =>
  `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;

/** Envia uma mensagem como a plataforma de mensagens faria: webhook assinado. */
export async function webhook(
  body: Record<string, unknown>,
  options: { signature?: string } = {},
): Promise<{ status: number; body: AgentReply }> {
  const raw = JSON.stringify(body);
  const response = await fetch(`${STACK.agentUrl}/channels/mock-whatsapp/webhook`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-signature-256': options.signature ?? sign(raw),
    },
    body: raw,
  });
  return { status: response.status, body: (await response.json()) as AgentReply };
}

/** Uma conversa de um cliente: cada chamada gera um id de mensagem novo. */
export function customer(phone: string) {
  const send = async (message: { text?: string; button?: { payload: string; title: string } }) => {
    const { status, body } = await webhook({
      messageId: `e2e-${randomUUID()}`,
      from: phone,
      ...message,
    });
    if (status !== 200) throw new Error(`webhook respondeu ${String(status)}`);
    return body;
  };
  return {
    say: (text: string) => send({ text }),
    press: (button: { payload: string; title: string }) => send({ button }),
  };
}

export const textOf = (reply: AgentReply): string => reply.messages.map((m) => m.text).join('\n');

export async function simulator(path: string, init: { method?: string; body?: unknown } = {}) {
  const response = await fetch(`${STACK.agentUrl}/simulator${path}`, {
    method: init.method ?? 'POST',
    headers: { 'content-type': 'application/json' },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  if (!response.ok) throw new Error(`simulador respondeu ${String(response.status)} em ${path}`);
  return (await response.json()) as Record<string, unknown>;
}

/** Recria os dados de demonstração, encerra conversas e desliga as falhas simuladas. */
export const resetDemo = () => simulator('/demo/reset');

/** Consulta a API principal diretamente (fonte da verdade), com a chave do Swagger. */
export async function orderStatus(customerId: string, orderId: string): Promise<string> {
  const response = await fetch(`${STACK.ordersUrl}/v1/customers/${customerId}/orders/${orderId}`, {
    headers: { 'x-api-key': STACK.ordersKey },
  });
  const body = (await response.json()) as { status: string };
  return body.status;
}

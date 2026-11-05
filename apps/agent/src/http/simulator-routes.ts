import { randomUUID } from 'node:crypto';

import { Router } from 'express';
import { z } from 'zod';

import type { AgentService } from '../agent/agent-service.js';
import type { ConversationStore } from '../conversation/store.js';
import type { ChaosState } from '../demo/chaos.js';
import { PERSONAS } from '../demo/personas.js';
import { WebhookPayloadSchema } from './agent-app.js';

/** Operações de demonstração na API de pedidos (rotas internas habilitadas com DEMO_MODE). */
export interface OrdersDemoClient {
  reset(): Promise<void>;
  shipOrder(orderId: string): Promise<{ shipped: boolean; status: number }>;
}

export interface SimulatorDependencies {
  readonly agent: AgentService;
  readonly store: ConversationStore;
  readonly chaos: ChaosState;
  readonly ordersDemo: OrdersDemoClient;
  readonly info: { model: string; promptVersion: string; llmConfigured: boolean };
}

const SendSchema = z.object({
  from: z.string(),
  text: z.string().optional(),
  button: z.object({ payload: z.string(), title: z.string() }).optional(),
});

const ChaosSchema = z.strictObject({
  ordersApiDown: z.boolean().optional(),
  catalogDown: z.boolean().optional(),
  llmDown: z.boolean().optional(),
});

/**
 * API do simulador (somente DEMO_MODE). O simulador faz o papel da plataforma de mensagens:
 * as mensagens passam pelo mesmo AgentService que atende o webhook assinado.
 */
export function simulatorRouter(deps: SimulatorDependencies): Router {
  const router = Router();

  router.get('/state', (_req, res) => {
    res.json({ personas: PERSONAS, chaos: deps.chaos.snapshot(), ...deps.info });
  });

  router.post('/messages', async (req, res) => {
    const input = SendSchema.parse(req.body);
    const payload = WebhookPayloadSchema.parse({ messageId: `sim-${randomUUID()}`, ...input });
    const reply = await deps.agent.handle({
      messageId: payload.messageId,
      from: payload.from,
      ...(payload.text === undefined ? {} : { text: payload.text }),
      ...(payload.button ? { button: payload.button } : {}),
    });
    const [trace] = (await deps.store.listTraces(reply.conversationId, 1)).slice(-1);
    res.json({ reply, trace: trace ?? null });
  });

  router.get('/conversations/:conversationId/traces', async (req, res) => {
    res.json({ traces: await deps.store.listTraces(req.params.conversationId, 50) });
  });

  router.post('/conversations/end', async (req, res) => {
    const { from } = z.object({ from: z.string() }).parse(req.body);
    await deps.agent.endConversation(from);
    res.json({ ended: true });
  });

  router.put('/chaos', (req, res) => {
    Object.assign(deps.chaos, ChaosSchema.parse(req.body));
    res.json({ chaos: deps.chaos.snapshot() });
  });

  router.post('/demo/reset', async (_req, res) => {
    await deps.ordersDemo.reset();
    await Promise.all(PERSONAS.map((persona) => deps.agent.endConversation(persona.phone)));
    Object.assign(deps.chaos, { ordersApiDown: false, catalogDown: false, llmDown: false });
    res.json({ reset: true });
  });

  router.post('/demo/orders/:orderId/ship', async (req, res) => {
    const orderId = z
      .string()
      .regex(/^\d{6}$/)
      .parse(req.params.orderId);
    res.json(await deps.ordersDemo.shipOrder(orderId));
  });

  return router;
}

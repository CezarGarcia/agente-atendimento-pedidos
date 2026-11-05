import type { AgentReply, ChaosFlags, SimulatorState, TurnTrace } from './types';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json' },
  });
  if (!response.ok) {
    const problem = (await response.json().catch(() => null)) as { detail?: string } | null;
    throw new Error(problem?.detail ?? `Falha na requisição (${response.status})`);
  }
  return (await response.json()) as T;
}

export const api = {
  state: () => request<SimulatorState>('/simulator/state'),

  send: (from: string, message: { text?: string; button?: { payload: string; title: string } }) =>
    request<{ reply: AgentReply; trace: TurnTrace | null }>('/simulator/messages', {
      method: 'POST',
      body: JSON.stringify({ from, ...message }),
    }),

  endConversation: (from: string) =>
    request<{ ended: boolean }>('/simulator/conversations/end', {
      method: 'POST',
      body: JSON.stringify({ from }),
    }),

  setChaos: (flags: Partial<ChaosFlags>) =>
    request<{ chaos: ChaosFlags }>('/simulator/chaos', {
      method: 'PUT',
      body: JSON.stringify(flags),
    }),

  resetDemo: () => request<{ reset: boolean }>('/simulator/demo/reset', { method: 'POST' }),

  shipOrder: (orderId: string) =>
    request<{ shipped: boolean; status: number }>(`/simulator/demo/orders/${orderId}/ship`, {
      method: 'POST',
    }),
};

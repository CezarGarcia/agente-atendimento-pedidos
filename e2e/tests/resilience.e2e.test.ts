import { randomUUID } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  PERSONAS,
  customer,
  orderStatus,
  resetDemo,
  simulator,
  textOf,
  webhook,
} from '../support/stack.js';

beforeEach(async () => {
  await resetDemo();
});

afterEach(async () => {
  await simulator('/chaos', {
    method: 'PUT',
    body: { ordersApiDown: false, catalogDown: false, llmDown: false },
  });
});

describe('falhas e robustez, ponta a ponta', () => {
  it('API de pedidos fora do ar: o agente não afirma nada sobre o pedido (regra 6)', async () => {
    const ana = customer(PERSONAS.ana.phone);
    await ana.say('oi'); // identifica o cliente antes da falha
    await simulator('/chaos', { method: 'PUT', body: { ordersApiDown: true } });
    const reply = await ana.say('Qual o status do pedido 100101?');
    expect(textOf(reply)).toContain('Não consegui consultar');
    expect(textOf(reply)).not.toContain('em processamento');
  });

  it('API de pedidos cai na hora de executar: resultado incerto, nunca sucesso', async () => {
    const ana = customer(PERSONAS.ana.phone);
    const confirmation = await ana.say('Quero cancelar o pedido 100101');
    await simulator('/chaos', { method: 'PUT', body: { ordersApiDown: true } });

    const uncertain = await ana.press(confirmation.messages[0]!.quickReplies![0]!);
    expect(textOf(uncertain)).toContain('não consegui confirmar');
    expect(textOf(uncertain)).not.toContain('foi cancelado');

    // Com a API de volta, a nova tentativa usa a mesma chave de idempotência.
    await simulator('/chaos', { method: 'PUT', body: { ordersApiDown: false } });
    const retry = await ana.press(uncertain.messages[0]!.quickReplies![0]!);
    expect(textOf(retry)).toContain('foi cancelado');
    expect(await orderStatus(PERSONAS.ana.customerId, '100101')).toBe('CANCELLED');
  });

  it('catálogo fora do ar: o atendimento segue sem os nomes dos produtos', async () => {
    await simulator('/chaos', { method: 'PUT', body: { catalogDown: true } });
    const ana = customer(PERSONAS.ana.phone);
    const reply = await ana.say('Qual o status do pedido 100101?');
    expect(textOf(reply)).toContain('em processamento');
    expect(textOf(reply)).toContain('item sem detalhes');
  });

  it('modelo indisponível: resposta segura e a confirmação pendente continua funcionando', async () => {
    const ana = customer(PERSONAS.ana.phone);
    const confirmation = await ana.say('Quero cancelar o pedido 100101');
    await simulator('/chaos', { method: 'PUT', body: { llmDown: true } });

    expect(textOf(await ana.say('oi'))).toContain('instabilidade');
    // A confirmação não depende do modelo: o botão ainda cancela.
    const result = await ana.press(confirmation.messages[0]!.quickReplies![0]!);
    expect(textOf(result)).toContain('foi cancelado');
  });

  it('reentrega do mesmo webhook não processa a mensagem duas vezes', async () => {
    const body = {
      messageId: `e2e-${randomUUID()}`,
      from: PERSONAS.bruno.phone,
      text: 'Quero cancelar o pedido 100201',
    };
    const first = await webhook(body);
    const second = await webhook(body);
    expect(second.body).toEqual(first.body);
  });
});

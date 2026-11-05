import { beforeEach, describe, expect, it } from 'vitest';

import { PERSONAS, customer, orderStatus, resetDemo, simulator, textOf } from '../support/stack.js';

/*
 * Ponta a ponta: webhook assinado → agente (modelo stub na fronteira de rede) → API de pedidos
 * → PostgreSQL. As asserções finais olham o estado na API principal, não só o texto da resposta.
 */

beforeEach(async () => {
  await resetDemo();
});

describe('regras de negócio, ponta a ponta', () => {
  it('consulta status com dados da API principal e nomes do catálogo externo', async () => {
    const ana = customer(PERSONAS.ana.phone);
    const reply = await ana.say('Qual o status do pedido 100101?');
    expect(textOf(reply)).toContain('em processamento');
    expect(textOf(reply)).toContain('R$ 829,80');
    expect(textOf(reply)).toContain('Fjallraven');
  });

  it('cancela somente após confirmação explícita e informa o resultado da API', async () => {
    const ana = customer(PERSONAS.ana.phone);
    const confirmation = await ana.say('Quero cancelar o pedido 100101');
    const confirmButton = confirmation.messages[0]?.quickReplies?.[0];

    expect(confirmButton?.title).toBe('Sim, cancelar');
    expect(await orderStatus(PERSONAS.ana.customerId, '100101')).toBe('PROCESSING');

    const result = await ana.press(confirmButton!);
    expect(textOf(result)).toContain('foi cancelado');
    expect(await orderStatus(PERSONAS.ana.customerId, '100101')).toBe('CANCELLED');
  });

  it('pedido enviado não é cancelado e o agente oferece atendimento humano', async () => {
    const ana = customer(PERSONAS.ana.phone);
    const reply = await ana.say('Cancela o pedido 100102');
    expect(textOf(reply)).toContain('já foi enviado');
    expect(textOf(reply)).toContain('atendente');
    expect(reply.messages[0]?.quickReplies).toBeUndefined();
    expect(await orderStatus(PERSONAS.ana.customerId, '100102')).toBe('SHIPPED');
  });

  it('pedido aguardando pagamento não é cancelado pelo fluxo automatizado', async () => {
    const carla = customer(PERSONAS.carla.phone);
    const reply = await carla.say('Quero cancelar o pedido 100301');
    expect(textOf(reply)).toContain('aguarda pagamento');
    expect(await orderStatus(PERSONAS.carla.customerId, '100301')).toBe('AWAITING_PAYMENT');
  });

  it('se o pedido for despachado entre a pergunta e o "sim", a API recusa e o agente informa', async () => {
    const bruno = customer(PERSONAS.bruno.phone);
    const confirmation = await bruno.say('Quero cancelar o pedido 100201');
    await simulator('/demo/orders/100201/ship');

    const result = await bruno.say('sim');
    expect(textOf(result)).toContain('Não consegui cancelar o pedido');
    expect(textOf(result)).not.toContain('foi cancelado');
    expect(confirmation.messages[0]?.quickReplies).toHaveLength(2);
    expect(await orderStatus(PERSONAS.bruno.customerId, '100201')).toBe('SHIPPED');
  });

  it('"não" mantém o pedido', async () => {
    const bruno = customer(PERSONAS.bruno.phone);
    await bruno.say('Quero cancelar o pedido 100201');
    const reply = await bruno.say('não');
    expect(textOf(reply)).toContain('continua ativo');
    expect(await orderStatus(PERSONAS.bruno.customerId, '100201')).toBe('PROCESSING');
  });

  it('atendimento humano gera protocolo e pausa o agente', async () => {
    const ana = customer(PERSONAS.ana.phone);
    const reply = await ana.say('Quero falar com um atendente');
    expect(textOf(reply)).toMatch(/ATD-\d{6}/);
    const next = await ana.say('oi?');
    expect(textOf(next)).toContain('já foi encaminhada para um atendente');
  });
});

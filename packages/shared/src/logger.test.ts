import { Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { runWithContext } from './context.js';
import { createLogger } from './logger.js';

function captureLogger() {
  const lines: Record<string, unknown>[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      lines.push(JSON.parse(chunk.toString()) as Record<string, unknown>);
      callback();
    },
  });
  return { logger: createLogger({ service: 'test', destination }), lines };
}

describe('createLogger', () => {
  it('emite JSON estruturado com serviço, nível textual e timestamp ISO', () => {
    const { logger, lines } = captureLogger();
    logger.info({ event: 'order.lookup', orderId: '100234' }, 'pedido consultado');

    expect(lines[0]).toMatchObject({
      level: 'info',
      service: 'test',
      event: 'order.lookup',
      orderId: '100234',
      msg: 'pedido consultado',
    });
    expect(lines[0]!['time']).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('inclui automaticamente o correlationId e campos do contexto', () => {
    const { logger, lines } = captureLogger();
    runWithContext(
      { correlationId: 'corr-12345678', fields: { conversationRef: 'conv_1' } },
      () => {
        logger.info({ event: 'x' }, 'dentro do contexto');
      },
    );
    expect(lines[0]).toMatchObject({ correlationId: 'corr-12345678', conversationRef: 'conv_1' });
  });

  it('redige credenciais e dados pessoais logados por engano', () => {
    const { logger, lines } = captureLogger();
    logger.info({
      req: { headers: { authorization: 'Bearer abc', 'x-api-key': 'k' } },
      customer: { phone: '+5551998765432', email: 'a@b.com', id: 'c1' },
    });
    const serialized = JSON.stringify(lines[0]);
    expect(serialized).not.toContain('Bearer abc');
    expect(serialized).not.toContain('998765432');
    expect(serialized).not.toContain('a@b.com');
    expect(serialized).toContain('c1');
  });
});

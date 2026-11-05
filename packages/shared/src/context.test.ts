import { describe, expect, it } from 'vitest';

import { addContextFields, getContext, resolveCorrelationId, runWithContext } from './context.js';

describe('contexto de correlação', () => {
  it('aceita um correlation id bem formado vindo de fora', () => {
    expect(resolveCorrelationId('abc-12345678')).toBe('abc-12345678');
  });

  it('gera um novo id quando o recebido é inválido (evita log injection)', () => {
    const generated = resolveCorrelationId('x\n{"level":"fatal"}');
    expect(generated).toMatch(/^[0-9a-f-]{36}$/);
    expect(resolveCorrelationId(undefined)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('isola o contexto entre execuções assíncronas concorrentes', async () => {
    const observed: string[] = [];
    await Promise.all(
      ['a', 'b'].map((id) =>
        runWithContext({ correlationId: `corr-${id}-0000000` }, async () => {
          await new Promise((resolve) => setTimeout(resolve, id === 'a' ? 10 : 1));
          addContextFields({ step: id });
          observed.push(`${getContext()?.correlationId}:${String(getContext()?.fields['step'])}`);
        }),
      ),
    );
    expect(observed.sort()).toEqual(['corr-a-0000000:a', 'corr-b-0000000:b']);
  });
});

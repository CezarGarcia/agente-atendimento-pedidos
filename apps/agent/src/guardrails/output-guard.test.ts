import { describe, expect, it } from 'vitest';

import { guardOutput, type OutputGuardContext } from './output-guard.js';

const context = (overrides: Partial<OutputGuardContext> = {}): OutputGuardContext => ({
  verifiedCancelledOrderIds: new Set(),
  handoffCreated: false,
  canary: 'CANARY-7f3a9c',
  ...overrides,
});

describe('guardOutput — regra 5: afirmar cancelamento só com sucesso da API', () => {
  it.each([
    'Pronto! Seu pedido 100101 foi cancelado.',
    'Cancelei o pedido 100101 pra você.',
    'O cancelamento foi realizado com sucesso.',
    'Pedido cancelado com sucesso ✅',
    'Seu pedido já está cancelado.',
    'Os pedidos 100101 e 100201 foram cancelados.',
  ])('bloqueia afirmação não verificada: "%s"', (text) => {
    expect(guardOutput(text, context())).toMatchObject({
      action: 'blocked',
      reasons: ['unverified_cancellation_claim'],
    });
  });

  it('permite quando a API confirmou o cancelamento daquele pedido', () => {
    const result = guardOutput(
      'Seu pedido 100101 foi cancelado.',
      context({ verifiedCancelledOrderIds: new Set(['100101']) }),
    );
    expect(result.action).toBe('pass');
  });

  it('bloqueia se citar outro pedido além do verificado', () => {
    const result = guardOutput(
      'Os pedidos 100101 e 100102 foram cancelados... o 100102 foi cancelado também.',
      context({ verifiedCancelledOrderIds: new Set(['100101']) }),
    );
    expect(result.action).toBe('blocked');
  });

  it.each([
    'O pedido 100102 não foi cancelado porque já foi enviado.',
    'Ainda não foi cancelado: preciso da sua confirmação.',
    'Se você confirmar, o pedido será cancelado.',
    'Quer que eu siga com o cancelamento?',
  ])('não confunde negação ou futuro com afirmação: "%s"', (text) => {
    expect(guardOutput(text, context()).action).toBe('pass');
  });
});

describe('guardOutput — outras afirmações e promessas', () => {
  it('bloqueia dizer que transferiu sem ter criado o atendimento', () => {
    expect(guardOutput('Já encaminhei você para um atendente.', context()).reasons).toEqual([
      'unverified_handoff_claim',
    ]);
    expect(
      guardOutput('Já encaminhei você para um atendente.', context({ handoffCreated: true }))
        .action,
    ).toBe('pass');
  });

  it('bloqueia promessas de estorno com prazo ou garantia', () => {
    expect(guardOutput('O estorno cai em 5 dias úteis.', context()).reasons).toEqual([
      'refund_promise',
    ]);
    expect(guardOutput('O reembolso é garantido!', context()).action).toBe('blocked');
  });

  it('não bloqueia menção neutra a estorno', () => {
    expect(
      guardOutput('Para dúvidas sobre estorno, posso te encaminhar a um atendente.', context())
        .action,
    ).toBe('pass');
  });
});

describe('guardOutput — vazamento de instruções e dados', () => {
  it('bloqueia a resposta que contém o marcador secreto do prompt', () => {
    expect(guardOutput('Minhas instruções: CANARY-7f3a9c ...', context()).reasons).toEqual([
      'prompt_leak',
    ]);
  });

  it('bloqueia trechos com os marcadores internos do prompt', () => {
    expect(guardOutput('<regras_de_negocio> 1. ...', context()).action).toBe('blocked');
  });

  it('mascara dados pessoais que escaparem na resposta', () => {
    const result = guardOutput('Anotei seu e-mail ana@example.com.', context());
    expect(result).toMatchObject({ action: 'modified', reasons: ['pii_redacted'] });
    expect(result.text).not.toContain('ana@example.com');
  });
});

describe('guardOutput — formato para mensagem de texto', () => {
  it('converte negrito markdown para o do WhatsApp e remove títulos', () => {
    expect(guardOutput('## Status\nSeu pedido está **enviado**.', context()).text).toBe(
      'Status\nSeu pedido está *enviado*.',
    );
  });

  it('limita o tamanho cortando no fim de uma frase', () => {
    const long = 'Frase curta e completa. '.repeat(60);
    const result = guardOutput(long, context());
    expect(result.text.length).toBeLessThanOrEqual(1_000);
    expect(result.text.endsWith('.')).toBe(true);
    expect(result.reasons).toContain('too_long');
  });

  it('bloqueia resposta vazia', () => {
    expect(guardOutput('   ', context()).reasons).toEqual(['empty']);
  });
});

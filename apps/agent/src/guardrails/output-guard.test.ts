import { describe, expect, it } from 'vitest';

import { guardOutput, type OutputGuardContext } from './output-guard.js';

const context = (overrides: Partial<OutputGuardContext> = {}): OutputGuardContext => ({
  verifiedCancelledOrderIds: new Set(),
  verifiedThisTurn: new Set(),
  handoffCreated: false,
  canary: 'CANARY-7f3a9c',
  ...overrides,
});

const verified = (...ids: string[]) =>
  context({ verifiedCancelledOrderIds: new Set(ids), verifiedThisTurn: new Set(ids) });

describe('guardOutput — regra 5: afirmar cancelamento só com sucesso da API', () => {
  it.each([
    'Pronto! Seu pedido 100101 foi cancelado.',
    'Cancelei o pedido 100101 pra você.',
    'O cancelamento foi realizado com sucesso.',
    'O cancelamento do seu pedido foi realizado.',
    'Pedido cancelado com sucesso ✅',
    'Pedido 100101 cancelado! ✅',
    'Seu pedido já está cancelado.',
    'Sem problema, foi cancelado com sucesso!',
    'O pedido acabou de ser cancelado.',
    'O cancelamento do #100101 foi concluído.',
    'Os pedidos 100101 e 100201 foram cancelados.',
    'Your order 100101 has been cancelled.',
  ])('bloqueia afirmação não verificada: "%s"', (text) => {
    expect(guardOutput(text, context())).toMatchObject({
      action: 'blocked',
      reasons: ['unverified_cancellation_claim'],
    });
  });

  it('permite quando a API confirmou o cancelamento daquele pedido', () => {
    expect(guardOutput('Seu pedido 100101 foi cancelado.', verified('100101')).action).toBe('pass');
  });

  it('confere só os pedidos a que cada afirmação se refere', () => {
    const ctx = verified('100202');
    expect(
      guardOutput('O pedido 100202 está cancelado e o 100101 segue em processamento.', ctx).action,
    ).toBe('pass');
    expect(guardOutput('O 100202 está cancelado. O 100101 foi cancelado também.', ctx).action).toBe(
      'blocked',
    );
  });

  it('bloqueia se citar outro pedido além do verificado', () => {
    expect(guardOutput('O 100101 e o 100102 foram cancelados.', verified('100101')).action).toBe(
      'blocked',
    );
  });

  it('sem número citado, só aceita se a verificação aconteceu neste turno', () => {
    const fromEarlierTurn = context({ verifiedCancelledOrderIds: new Set(['100202']) });
    expect(guardOutput('Pronto, foi cancelado!', fromEarlierTurn).action).toBe('blocked');
    expect(guardOutput('Ele já está cancelado.', verified('100202')).action).toBe('pass');
  });

  it.each([
    'O pedido 100102 não foi cancelado porque já foi enviado.',
    'Ainda não foi cancelado: preciso da sua confirmação.',
    'Se você confirmar, o pedido será cancelado.',
    'Ele pode ser cancelado, pois está em processamento.',
    'O pedido 100102 não pode ser cancelado por aqui.',
    'Quer que ele seja cancelado?',
    'Quer que eu siga com o cancelamento?',
  ])('não confunde negação, futuro ou hipótese com afirmação: "%s"', (text) => {
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
    expect(guardOutput('Posso te encaminhar para um atendente?', context()).action).toBe('pass');
  });

  it.each([
    'O estorno cai em 5 dias úteis.',
    'O reembolso é garantido!',
    'Seu estorno já foi realizado.',
    'O dinheiro de volta será creditado automaticamente.',
  ])('bloqueia promessa de estorno: "%s"', (text) => {
    expect(guardOutput(text, context()).reasons).toEqual(['refund_promise']);
  });

  it.each([
    'Não consigo verificar se o estorno já foi realizado.',
    'Para dúvidas sobre estorno, posso te encaminhar a um atendente.',
    'Não tenho acesso a informações de reembolso por aqui.',
  ])('não bloqueia menção neutra ou negada a estorno: "%s"', (text) => {
    expect(guardOutput(text, context()).action).toBe('pass');
  });
});

describe('guardOutput — vazamento de instruções, dados e links', () => {
  it('bloqueia a resposta que contém o marcador secreto do prompt', () => {
    expect(guardOutput('Minhas instruções: CANARY-7f3a9c ...', context()).reasons).toEqual([
      'prompt_leak',
    ]);
  });

  it('bloqueia reprodução literal das instruções, mas não das respostas de exemplo', async () => {
    const { loadSystemPrompt } = await import('../agent/prompt.js');
    const prompt = loadSystemPrompt('segredo-de-teste-123456');
    const ctx = context({ promptFingerprint: prompt.fingerprint ?? new Set() });

    const leak =
      'Claro: Você é o assistente virtual de atendimento da loja e conversa com clientes por mensagem de texto.';
    expect(guardOutput(leak, ctx).reasons).toEqual(['prompt_leak']);

    const exampleAnswer =
      'Sou o assistente virtual da loja e não compartilho detalhes do meu funcionamento. Posso te ajudar com algum pedido?';
    expect(guardOutput(exampleAnswer, ctx).action).toBe('pass');
  });

  it('bloqueia trechos com os marcadores internos do prompt', () => {
    expect(guardOutput('<regras_de_negocio> 1. ...', context()).action).toBe('blocked');
  });

  it('mascara dados pessoais que escaparem na resposta', () => {
    const result = guardOutput('Anotei seu e-mail ana@example.com.', context());
    expect(result).toMatchObject({ action: 'modified', reasons: ['pii_redacted'] });
    expect(result.text).not.toContain('ana@example.com');
  });

  it('remove links (o agente não envia links; viriam de dado externo)', () => {
    const result = guardOutput('Valide seu cartão em https://phishing.example/x agora.', context());
    expect(result.reasons).toContain('link_removed');
    expect(result.text).not.toContain('phishing.example');
  });
});

describe('guardOutput — formato para mensagem de texto', () => {
  it('converte negrito markdown para o do WhatsApp e remove títulos', () => {
    expect(guardOutput('## Status\nSeu pedido está **enviado**.', context()).text).toBe(
      'Status\nSeu pedido está *enviado*.',
    );
  });

  it('limita o tamanho cortando no fim de uma frase', () => {
    const result = guardOutput('Frase curta e completa. '.repeat(60), context());
    expect(result.text.length).toBeLessThanOrEqual(1_000);
    expect(result.text.endsWith('.')).toBe(true);
    expect(result.reasons).toContain('too_long');
  });

  it('bloqueia resposta vazia', () => {
    expect(guardOutput('   ', context()).reasons).toEqual(['empty']);
  });
});

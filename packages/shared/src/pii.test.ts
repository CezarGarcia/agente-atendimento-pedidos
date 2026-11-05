import { describe, expect, it } from 'vitest';

import { isValidCpf, isValidLuhn, pseudonymize, redactPii } from './pii.js';

describe('redactPii', () => {
  it.each([
    ['meu email é maria.silva@example.com', 'email', 'maria.silva@example.com'],
    ['cartão 4111 1111 1111 1111 pode usar', 'card', '4111 1111 1111 1111'],
    ['CPF 529.982.247-25', 'cpf', '529.982.247-25'],
    ['cpf 52998224725 ok', 'cpf', '52998224725'],
    ['CNPJ 11.222.333/0001-81', 'cnpj', '11.222.333/0001-81'],
    ['me liga no (51) 99876-5432', 'phone', '99876-5432'],
    ['whats +55 51 998765432', 'phone', '998765432'],
  ] as const)('mascara %s', (input, kind, secret) => {
    const result = redactPii(input);
    expect(result.detected).toContain(kind);
    expect(result.text).not.toContain(secret);
  });

  it('não altera números de pedido, valores e datas', () => {
    const input = 'Quero cancelar o pedido 100234 de R$ 109,95 feito em 05/11/2026';
    expect(redactPii(input)).toEqual({ text: input, detected: [] });
  });

  it('não confunde sequência de 16 dígitos inválida (Luhn) com cartão', () => {
    expect(redactPii('protocolo 1234567812345678').detected).not.toContain('card');
  });

  it('mascara vários dados na mesma mensagem e reporta apenas os tipos', () => {
    const result = redactPii('sou ana@example.com, cpf 529.982.247-25');
    expect(result.detected).toEqual(expect.arrayContaining(['email', 'cpf']));
    expect(result.text).toBe('sou [EMAIL REMOVIDO], cpf [CPF REMOVIDO]');
  });
});

describe('validadores', () => {
  it('valida CPF pelos dígitos verificadores', () => {
    expect(isValidCpf('529.982.247-25')).toBe(true);
    expect(isValidCpf('529.982.247-24')).toBe(false);
    expect(isValidCpf('111.111.111-11')).toBe(false);
  });

  it('valida cartão pelo algoritmo de Luhn', () => {
    expect(isValidLuhn('4111111111111111')).toBe(true);
    expect(isValidLuhn('4111111111111112')).toBe(false);
  });
});

describe('pseudonymize', () => {
  it('é estável para o mesmo segredo e diferente entre segredos', () => {
    const a = pseudonymize('+5551998765432', 'segredo-a', 'cus');
    expect(a).toBe(pseudonymize('+5551998765432', 'segredo-a', 'cus'));
    expect(a).not.toBe(pseudonymize('+5551998765432', 'segredo-b', 'cus'));
    expect(a).toMatch(/^cus_[0-9a-f]{16}$/);
    expect(a).not.toContain('99876');
  });
});

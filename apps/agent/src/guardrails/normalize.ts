/**
 * Normalização para VERIFICAÇÕES de segurança (nunca para o texto exibido ao cliente).
 *
 * Os guardrails comparam texto com padrões. Sem normalizar, o mesmo conteúdo passa escrito de
 * outro jeito, e o red team achou todos estes: caracteres invisíveis no meio da palavra
 * ("can­celado"), letras de outros alfabetos que parecem latinas (cirílico "cаncelado"),
 * largura total ("ＣＡＮＣＥＬＡＤＯ"), formatação do WhatsApp ("_cancelado_", "**cancel**ado")
 * e letras espaçadas ("c-a-n-c-e-l-a-d-o", "C A N C E L A D O").
 */

/**
 * Formato invisível: \p{Cf} (zero-width, bidi, soft hyphen, tags Unicode U+E0000…) e outros
 * caracteres que não aparecem na tela (joiner, fillers de Hangul e Khmer, seletores de variação).
 */
const INVISIBLE_RANGES: readonly (readonly [number, number])[] = [
  [0x034f, 0x034f],
  [0x115f, 0x1160],
  [0x17b4, 0x17b5],
  [0x180b, 0x180e],
  [0x3164, 0x3164],
  [0xfe00, 0xfe0f],
  [0xffa0, 0xffa0],
];
const codePoint = (n: number): string => `\\u{${n.toString(16)}}`;
const INVISIBLE = new RegExp(
  [
    String.raw`\p{Cf}`,
    ...INVISIBLE_RANGES.map(([from, to]) => `[${codePoint(from)}-${codePoint(to)}]`),
  ].join('|'),
  'gu',
);

/** Letras cirílicas e gregas (já em minúsculas) que se passam por latinas. */
const CONFUSABLES: Readonly<Record<string, string>> = {
  а: 'a',
  в: 'b',
  е: 'e',
  ё: 'e',
  к: 'k',
  м: 'm',
  н: 'h',
  о: 'o',
  р: 'p',
  с: 'c',
  т: 't',
  у: 'y',
  х: 'x',
  і: 'i',
  ї: 'i',
  ј: 'j',
  ѕ: 's',
  ԁ: 'd',
  ԛ: 'q',
  ԝ: 'w',
  һ: 'h',
  ɑ: 'a',
  α: 'a',
  β: 'b',
  ε: 'e',
  η: 'n',
  ι: 'i',
  κ: 'k',
  μ: 'u',
  ν: 'v',
  ο: 'o',
  ρ: 'p',
  τ: 't',
  υ: 'u',
  χ: 'x',
  ω: 'w',
};
const CONFUSABLE_PATTERN = new RegExp(`[${Object.keys(CONFUSABLES).join('')}]`, 'gu');

/** Remove os caracteres invisíveis (usado também no saneamento de dados externos). */
export const stripInvisible = (text: string): string => text.replace(INVISIBLE, '');

/**
 * Minúsculas, sem acentos, sem invisíveis, com homóglifos mapeados para o latim, sem a
 * formatação do WhatsApp dentro das palavras e com letras espaçadas juntadas.
 */
export function securityNormalize(text: string): string {
  return (
    stripInvisible(text.normalize('NFKC'))
      .toLowerCase()
      .replace(CONFUSABLE_PATTERN, (char) => CONFUSABLES[char] ?? char)
      .normalize('NFKD')
      .replace(/\p{M}/gu, '')
      // Formatação no meio da palavra some ("**cancel**ado" → "cancelado"); fora dela vira espaço.
      .replace(/(?<=\p{L})[*_~`]+(?=\p{L})/gu, '')
      .replace(/[*_~`]/g, ' ')
      // Hífen entre letras some ("cance-lado" → "cancelado", "e-mail" → "email").
      .replace(/(?<=\p{L})-(?=\p{L})/gu, '')
      // Quatro ou mais letras isoladas por separador viram uma palavra ("c a n c e l a d o").
      .replace(/(?<![\p{L}\p{N}])\p{L}(?:[\s.-]\p{L}(?![\p{L}\p{N}])){3,}/gu, (m) =>
        m.replace(/[\s.-]/g, ''),
      )
  );
}

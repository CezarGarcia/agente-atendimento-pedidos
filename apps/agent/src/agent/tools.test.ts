import { describe, expect, it } from 'vitest';

import { shortenTitle } from './tools.js';

describe('shortenTitle — nome do produto na pergunta de confirmação', () => {
  it('mantém títulos curtos', () => {
    expect(shortenTitle('Mens Casual Slim Fit')).toBe('Mens Casual Slim Fit');
  });

  it('corta na vírgula quando ela deixa um nome reconhecível', () => {
    expect(shortenTitle('Fjallraven - Foldsack No. 1 Backpack, Fits 15 Laptops')).toBe(
      'Fjallraven - Foldsack No. 1 Backpack',
    );
  });

  it('sem vírgula útil, corta no fim de uma palavra e indica o corte', () => {
    expect(shortenTitle('Samsung 49-Inch CHG90 144Hz Curved Gaming Monitor (LC49HG90DMNXZA)')).toBe(
      'Samsung 49-Inch CHG90 144Hz Curved Gaming…',
    );
  });

  it('nunca deixa pontuação solta antes das reticências', () => {
    expect(shortenTitle('Premium Wireless Noise Cancelling Headset: Pro Black Edition')).toBe(
      'Premium Wireless Noise Cancelling Headset…',
    );
  });
});

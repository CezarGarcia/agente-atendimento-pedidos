import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { STACK, resetDemo } from '../support/stack.js';

let browser: Browser;

beforeAll(async () => {
  await resetDemo();
  browser = await chromium.launch(
    process.env['PLAYWRIGHT_CHROMIUM_PATH']
      ? { executablePath: process.env['PLAYWRIGHT_CHROMIUM_PATH'] }
      : {},
  );
});

afterAll(async () => {
  await browser.close();
});

describe('simulador web', () => {
  it('[E2E-U01] conduz o cancelamento com botões e mostra os bastidores do turno', async () => {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));

    await page.goto(STACK.agentUrl, { waitUntil: 'networkidle' });
    await page.getByText('Quero cancelar o pedido 100101').first().click();
    await page.getByRole('button', { name: 'Sim, cancelar' }).click();
    await page.getByText('foi cancelado').waitFor();

    await expect(page.getByText('Confirmação determinística').isVisible()).resolves.toBe(true);
    await expect(page.getByText('Turno resolvido sem chamar o modelo.').isVisible()).resolves.toBe(
      true,
    );
    expect(errors).toEqual([]);
    await page.close();
  });
});

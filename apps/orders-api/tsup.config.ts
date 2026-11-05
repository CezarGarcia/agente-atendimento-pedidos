import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/main.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  sourcemap: true,
  clean: true,
  // O pacote interno do monorepo é empacotado junto; as dependências de npm continuam externas.
  noExternal: ['@agente/shared'],
});

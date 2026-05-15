import {defineConfig} from 'vitest/config';

export default defineConfig({
  test: {
    exclude: ['pkmapp/**', 'node_modules/**', 'dist/**'],
  },
});

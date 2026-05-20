import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config';
import { playwright } from '@vitest/browser-playwright';

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      exclude: ['pkmapp/**', 'node_modules/**', 'dist/**'],
      browser: {
        enabled: true,
        provider: playwright(),
        instances: [{ browser: 'chromium' }],
        headless: true,
      },
    },
  }),
);

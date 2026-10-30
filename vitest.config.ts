import { defineConfig, defineProject, mergeConfig } from 'vite-plus/test/config';
import viteConfig from './vite.config';
import { playwright } from 'vite-plus/test/browser-playwright';

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      projects: [
        defineProject({
          test: {
            name: 'node',
            include: ['src/**/*.test.ts'],
            exclude: ['src/**/*.browser.test.ts', 'pkmapp/**', 'node_modules/**', 'dist/**'],
            environment: 'node',
          },
        }),
        defineProject({
          extends: true,
          test: {
            name: 'browser',
            include: ['src/**/*.browser.test.ts'],
            exclude: ['pkmapp/**', 'node_modules/**', 'dist/**'],
            browser: {
              enabled: true,
              provider: playwright(),
              instances: [{ browser: 'chromium' }],
              headless: true,
            },
          },
        }),
      ],
    },
  }),
);

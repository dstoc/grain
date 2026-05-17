import { defineConfig } from 'vite';
import babel from '@rolldown/plugin-babel';

function decoratorPreset(options: Record<string, unknown>) {
  return {
    preset: () => ({
      plugins: [['@babel/plugin-proposal-decorators', options]],
    }),
    rolldown: {
      filter: {
        code: '@',
      },
    },
  };
}

export default defineConfig({
  plugins: [
    babel({
      presets: [decoratorPreset({ version: '2023-11' })],
    }),
  ],
  server: {
    watch: {
      ignored: ['**/pkmapp/**'],
    },
  },
});

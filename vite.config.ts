import { defineConfig } from 'vite-plus';
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
  fmt: {
    singleQuote: true,
    ignorePatterns: ['coverage/**', 'dist/**', 'node_modules/**', 'pkmapp/**'],
  },
  lint: {
    ignorePatterns: ['coverage/**', 'dist/**', 'node_modules/**', 'pkmapp/**'],
    rules: {
      'no-unused-expressions': 'off',
      'no-constant-binary-expression': 'error',
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
    },
  },

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

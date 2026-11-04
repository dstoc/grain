import { registerHooks } from 'node:module';

// Node 26 erases TS. Redirect this repository's source .js imports to source .ts.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (error.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.endsWith('.js')) throw error;
      return nextResolve(specifier.slice(0, -3) + '.ts', context);
    }
  },
});

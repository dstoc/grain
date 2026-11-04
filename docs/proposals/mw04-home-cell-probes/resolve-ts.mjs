import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'vite/rolldown/utils';

// Source-only probes: resolve .js to .ts and compile parameter properties, which
// Node 26's strip-only loader cannot erase. Use the installed Vite transformer.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (error.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.endsWith('.js')) throw error;
      return nextResolve(specifier.slice(0, -3) + '.ts', context);
    }
  },
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    if (!url.endsWith('.ts')) return loaded;
    const result = transformSync(fileURLToPath(url), loaded.source.toString(), {
      target: 'esnext',
      tsconfig: false,
    });
    if (result.errors.length)
      throw new Error(result.errors.map((error) => error.message).join('\n'));
    return { ...loaded, format: 'module', source: result.code };
  },
});

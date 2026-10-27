import { build } from 'esbuild'

// Match DSH's module-table factory protocol; native primitives and React are shared.
export const clientExternals = ['react', 'react/jsx-runtime', '@deepseek-ai/dsh-client-ui-primitives']
await build({
  entryPoints: ['src/client/index.ts'], outfile: 'lib/client.js', bundle: true,
  platform: 'browser', format: 'cjs', target: 'es2022', jsx: 'automatic',
  external: clientExternals, sourcemap: true,
  banner: { js: 'window.__ModuleLoader__.load({ id: "dsh-diary-memory", factory: (require) => { var module = { exports: {} }; var exports = module.exports;' },
  footer: { js: 'return module.exports; } });' },
})

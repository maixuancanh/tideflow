import { build } from 'esbuild';
await build({entryPoints:['server/standalone.ts'],bundle:true,platform:'node',format:'esm',target:'node22',outfile:'server-dist/standalone.mjs'});

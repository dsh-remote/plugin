import { defineConfig } from 'weapp-vite';

export default defineConfig({
  base: './',
  weapp: {
    srcRoot: 'src',
    platform: 'weapp',
    injectWeapi: { enabled: true, replaceWx: true },
    web: {
      enable: true,
      outDir: 'dist/web',
      pluginOptions: {
        runtime: {
          routing: { mode: 'hash' },
          warnings: { level: 'warn' },
        },
      },
    },
  },
});

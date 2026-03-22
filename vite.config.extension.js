/**
 * Vite Config — Extension Host 构建
 * ESM 源码 → CommonJS 输出 (VS Code 要求)
 */
import { defineConfig } from 'vite'
import path from 'path'

export default defineConfig({
  build: {
    lib: {
      entry: path.resolve(__dirname, 'src/extension/extension.js'),
      formats: ['cjs'],
      fileName: () => 'extension.js',
    },
    outDir: 'dist',
    emptyOutDir: false,
    rollupOptions: {
      external: [
        'vscode',
        'fs', 'path', 'os', 'http', 'https', 'tls', 'net',
        'crypto', 'child_process', 'url', 'zlib', 'stream',
        'buffer', 'events', 'util', 'querystring',
        'node:fs', 'node:path', 'node:os', 'node:http', 'node:https',
        'node:tls', 'node:net', 'node:crypto', 'node:child_process',
        'node:sqlite',
      ],
    },
    target: 'node22',
    minify: false,
    sourcemap: false,
  },
})

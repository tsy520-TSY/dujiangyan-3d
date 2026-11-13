import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  server: {
    port: 5180,
    host: '127.0.0.1',
    open: false,
  },
  resolve: {
    alias: {
      // three/addons/* 需要映射到 examples/jsm/*
      'three/addons': fileURLToPath(new URL('./node_modules/three/examples/jsm', import.meta.url)),
    },
  },
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 1200,
  },
});

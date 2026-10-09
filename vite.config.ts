import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  root: 'src/web',
  build: {
    outDir: '../../dist',
    emptyOutDir: true,
    // 默认 true：Vite 会把每个 chunk 逐个 gzip 一遍只为在终端打印体积。
    // 本项目 shiki 全量引入产出 240 个 chunk，这一步是纯浪费的 CPU 和内存。
    reportCompressedSize: false,
    rollupOptions: {
      // rollup 默认 20 路并发读文件。2 核 2GB 上降到 1，构建变慢但峰值内存更低。
      maxParallelFileOps: 1
    }
  },
  server: {
    port: 5179,
    proxy: {
      '/api': 'http://localhost:3000'
    }
  }
});

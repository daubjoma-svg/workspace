import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    // 沙箱安全删除守卫拦截 emptyOutDir 的批量删除，跳过清空避免误删
    emptyOutDir: false,
  },
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:4000' },
    // design-system/design-tokens.css 位于 vite root(web/) 之外，需放行仓库根目录
    fs: { allow: ['..'] },
  },
});

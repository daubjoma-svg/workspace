import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    // 沙箱安全删除守卫拦截 emptyOutDir 的批量删除，跳过清空避免误删
    emptyOutDir: false,
  },
  server: {
    // 开发模式允许同一局域网内的设备访问 Vite 页面。
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/api': 'http://localhost:4000',
      // 上传图片是静态资源，不经过 /api；开发模式也需代理到后端。
      '/uploads': 'http://localhost:4000',
    },
    // design-system/design-tokens.css 位于 vite root(web/) 之外，需放行仓库根目录
    fs: { allow: ['..'] },
  },
});

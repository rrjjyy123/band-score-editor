import { defineConfig } from 'vite';
import { alphaTab } from '@coderline/alphatab-vite';

// pywebview가 dist/를 file 서버로 띄우므로 상대 경로로 빌드
export default defineConfig({
  base: './',
  plugins: [alphaTab()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: { port: 5191, strictPort: true },
});

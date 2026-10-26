import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const env = { ...loadEnv(mode, root, ''), ...process.env };
  const frontendPort = Number(env.FRONTEND_PORT || 5173);
  const backendPort = Number(env.BACKEND_PORT || 3001);
  if (
    ![frontendPort, backendPort].every(
      (port) => Number.isInteger(port) && port > 0 && port <= 65535,
    )
  ) {
    throw new Error('服务端口必须为 1—65535 的整数');
  }
  return {
    plugins: [react()],
    envDir: root,
    server: {
      port: frontendPort,
      strictPort: true,
      proxy: { '/api': `http://127.0.0.1:${backendPort}` },
    },
  };
});

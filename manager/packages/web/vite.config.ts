import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: Number(process.env.PORT) || 5180,
    // D-MDEV-3: loopback only. The dev API it talks to runs with AUTH_MODE=disabled (D-MDEV-1), and the CORS
    // origin is http://localhost:5180, so serving the dev bundle on the LAN buys nothing. Opt in with --host.
    host: 'localhost',
  },
});

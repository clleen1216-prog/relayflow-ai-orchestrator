import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApiApp } from './server/app.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function resolveCliPort(): number {
  const portArgIdx = process.argv.indexOf('--port');
  if (portArgIdx !== -1) {
    const val = Number(process.argv[portArgIdx + 1]);
    if (Number.isFinite(val)) return val;
  }
  const eqArg = process.argv.find((a) => a.startsWith('--port='));
  if (eqArg) {
    const val = Number(eqArg.split('=')[1]);
    if (Number.isFinite(val)) return val;
  }
  return process.env.NODE_ENV === 'production'
    ? Number(process.env.PORT) || 3000
    : 3000;
}

async function startServer() {
  const app = createApiApp(__dirname);

  if (process.env.NODE_ENV !== 'production') {
    const vitePromise = import('vite')
      .then(({ createServer: createViteServer }) =>
        createViteServer({
          server: { middlewareMode: true, hmr: false, ws: false },
          appType: 'spa',
        })
      )
      .catch((err) => {
        console.error('Vite middleware initialization failed:', err);
        throw err;
      });

    app.use(async (req, res, next) => {
      try {
        const vite = await vitePromise;
        vite.middlewares(req, res, next);
      } catch (err) {
        next(err);
      }
    });
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('/{*splat}', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const port = resolveCliPort();
  app.listen(port, '0.0.0.0', () => {
    console.log(`RelayFlow server running at http://0.0.0.0:${port}`);
  });
}

startServer().catch((err) => {
  console.error('Fatal error starting RelayFlow server:', err);
  process.exit(1);
});

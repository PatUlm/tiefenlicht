import { existsSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import { fileURLToPath } from 'node:url';
import { validateDungeon } from '@dungeon/game-core';
import { PROTOTYPE_DUNGEON } from '@dungeon/game-core/content';
import { DEFAULT_SERVER_PORT, MAX_CLIENT_MESSAGE_BYTES, WS_PATH, type ServerMessage } from '@dungeon/shared';
import { WebSocketServer, type WebSocket } from 'ws';
import { ClientHandler } from './client-handler.ts';
import { GameRegistry } from './game-registry.ts';
import type { Connection } from './game-session.ts';
import { createStaticHandler } from './static-files.ts';

const port = Number(process.env.PORT ?? DEFAULT_SERVER_PORT);
// Loopback by default; Docker/LAN play opt in with HOST=0.0.0.0.
const host = process.env.HOST ?? '127.0.0.1';
// Built client: explicit STATIC_DIR (Docker) or the workspace's apps/client/dist.
const staticDir = process.env.STATIC_DIR ?? fileURLToPath(new URL('../../client/dist', import.meta.url));
/** Extra allowed browser origins (comma-separated), e.g. behind a reverse proxy. */
const allowedOrigins = new Set((process.env.ALLOWED_ORIGINS ?? '').split(',').map((o) => o.trim()).filter(Boolean));

/**
 * Browsers send an Origin header: only accept same-host pages (or configured
 * origins), so foreign websites cannot open game sockets from a visitor's browser.
 */
function isOriginAllowed(origin: string | undefined, hostHeader: string | undefined): boolean {
  if (!origin) return true; // non-browser clients
  if (allowedOrigins.has(origin)) return true;
  try {
    return new URL(origin).host === hostHeader;
  } catch {
    return false;
  }
}

const dungeonErrors = validateDungeon(PROTOTYPE_DUNGEON);
if (dungeonErrors.length > 0) {
  console.error('[server] invalid dungeon:\n  ' + dungeonErrors.join('\n  '));
  process.exit(1);
}

const registry = new GameRegistry(PROTOTYPE_DUNGEON);
const serveStatic = staticDir && existsSync(staticDir) ? createStaticHandler(staticDir) : undefined;

const httpServer = createServer((req, res) => {
  if (req.url === '/healthz') {
    res
      .writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      .end(JSON.stringify({ ok: true, games: registry.size, version: process.env.APP_VERSION ?? 'dev' }));
    return;
  }
  if (serveStatic) {
    serveStatic(req, res).catch((err) => {
      console.error('[server] static error', err);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Dungeon game server. Client runs via Vite in development.');
});

const wss = new WebSocketServer({
  server: httpServer,
  path: WS_PATH,
  maxPayload: MAX_CLIENT_MESSAGE_BYTES,
  verifyClient: ({ origin, req }: { origin: string | undefined; req: IncomingMessage }) =>
    isOriginAllowed(origin, req.headers.host),
});
const alive = new WeakMap<WebSocket, boolean>();

wss.on('connection', (socket) => {
  alive.set(socket, true);
  socket.on('pong', () => alive.set(socket, true));

  const conn: Connection = {
    send: (message: ServerMessage) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
    },
    close: (code, reason) => socket.close(code, reason),
  };
  const handler = new ClientHandler(conn, registry);

  socket.on('message', (data, isBinary) => {
    if (isBinary) return;
    handler.onMessage(data.toString());
  });
  socket.on('close', () => handler.onClose());
  socket.on('error', (err) => console.warn('[server] socket error', err.message));
});

// Heartbeat: drop sockets that stopped answering pings, so seats show as disconnected.
const heartbeat = setInterval(() => {
  for (const socket of wss.clients) {
    if (!alive.get(socket)) {
      socket.terminate();
      continue;
    }
    alive.set(socket, false);
    socket.ping();
  }
  registry.sweep();
}, 30_000);

httpServer.listen(port, host, () => {
  console.log(`[server] listening on http://${host}:${port} (ws path ${WS_PATH})`);
  if (serveStatic) console.log(`[server] serving client from ${staticDir}`);
});

function shutdown() {
  clearInterval(heartbeat);
  for (const socket of wss.clients) socket.close(1001, 'Server fährt herunter.');
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

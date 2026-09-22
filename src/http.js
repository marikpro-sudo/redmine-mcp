import { createService } from './runtime.js';
import { createHttpServer } from './http-server.js';
import { AccessError, safeError } from './config.js';
try {
  const token = process.env.REDMINE_ACCESS_TOKEN;
  if (!token || token.length < 32 || token.startsWith('replace-')) throw new AccessError('CONFIG', 'Set REDMINE_ACCESS_TOKEN to an independent random token of at least 32 characters.');
  const port = Number(process.env.REDMINE_ACCESS_PORT || 3210);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new AccessError('CONFIG', 'REDMINE_ACCESS_PORT must be 1024..65535.');
  const server = createHttpServer(await createService(), token);
  server.on('error', () => { console.error('HTTP listener failed. Check port availability.'); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.error(`Redmine API: http://127.0.0.1:${port}/v1/tools`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { server.close(); server.closeAllConnections(); });
} catch (error) { console.error(JSON.stringify({ error: safeError(error) })); process.exitCode = 1; }

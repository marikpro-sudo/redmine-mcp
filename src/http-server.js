import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { definitions } from './service.js';
import { safeError } from './config.js';

export function createHttpServer(service, token) {
  if (!token || token.length < 32) throw new Error('HTTP token must be at least 32 characters.');
  const expected = Buffer.from(`Bearer ${token}`);
  return createServer({ requestTimeout: 30000, headersTimeout: 10000 }, async (req, res) => {
    const reply = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(value)); };
    const actual = Buffer.from(req.headers.authorization || '');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      reply(401, { error: { code: 'UNAUTHORIZED', message: 'Local Bearer token required.' } }); return;
    }
    // Local machine API only. Do not accept browser origins or arbitrary Host headers.
    if (req.headers.origin || !/^127\.0\.0\.1:\d+$/.test(req.headers.host || '')) {
      reply(403, { error: { code: 'FORBIDDEN', message: 'Only local non-browser clients are supported.' } }); return;
    }
    if (req.method === 'GET' && req.url === '/v1/tools') {
      reply(200, Object.fromEntries(Object.entries(definitions).map(([k, v]) => [k, { description: v.description, inputSchema: z.toJSONSchema(v.schema, { io: 'input' }) }]))); return;
    }
    const match = /^\/v1\/tools\/(redmine_[a-z_]+)$/.exec(req.url || '');
    if (req.method !== 'POST' || !match || !definitions[match[1]]) { reply(404, { error: { code: 'NOT_FOUND', message: 'Unknown endpoint.' } }); return; }
    if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) { reply(415, { error: { code: 'CONTENT_TYPE', message: 'Use application/json.' } }); return; }
    try {
      let size = 0; const chunks = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 65536) { reply(413, { error: { code: 'TOO_LARGE', message: 'Request limit: 64 KiB.' } }); return; }
        chunks.push(chunk);
      }
      let args;
      try { args = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { reply(400, { error: { code: 'INVALID_ARGUMENTS', message: 'Expected JSON object.' } }); return; }
      const result = await service.invoke(match[1], args);
      const status = match[1] !== 'redmine_apply_change' || result.state === 'applied' ? 200 :
        result.state === 'rejected' ? 409 : result.state === 'in_progress_or_uncertain' ? 202 : 502;
      reply(status, result);
    } catch (error) {
      const safe = safeError(error);
      reply(safe.code === 'INVALID_ARGUMENTS' ? 400 : 502, { error: safe });
    }
  });
}

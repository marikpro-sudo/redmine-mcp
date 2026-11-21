import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { RedmineClient } from '../src/client.js';
import { RedmineService } from '../src/service.js';
import { createMcpServer } from '../src/mcp-server.js';

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'redmine-files-test-'));
  const stateDir = join(root, 'state');
  t.after(() => rm(root, { recursive: true }));
  const state = { puts: [], uploads: [], deletes: [], nextAttachment: 500, issue: { id: 87, subject: 'Старый заголовок',
    project: { id: 3, name: 'SAP' }, tracker: { id: 1, name: 'Task' }, status: { id: 1, name: 'Новая' },
    priority: { id: 2, name: 'Средний' }, assigned_to: { id: 7, name: 'Dev' }, done_ratio: 0,
    updated_on: '2026-01-01T00:00:00Z', journals: [], custom_fields: [], allowed_statuses: [],
    attachments: [{ id: 41, filename: 'old.txt', filesize: 3, content_type: 'text/plain', author: { id: 8, name: 'Other' }, created_on: '2026-01-01T00:00:00Z' }] } };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const json = (data, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
    const body = async () => { const c = []; for await (const x of req) c.push(x); return Buffer.concat(c); };
    if (url.pathname === '/users/current.json') return json({ user: { id: 7, login: 'dev', firstname: 'Dev' } });
    if (url.pathname === '/issues/87.json' && req.method === 'GET') return json({ issue: state.issue });
    if (url.pathname === '/uploads.json' && req.method === 'POST') {
      const bytes = await body();
      if (options.rejectUpload) return json({ errors: ['too big'] }, options.rejectUpload);
      state.uploads.push({ filename: url.searchParams.get('filename'), bytes, type: req.headers['content-type'] });
      return json({ upload: { id: state.uploads.length, token: `tok-${state.uploads.length}` } }, 201);
    }
    if (url.pathname === '/issues/87.json' && req.method === 'PUT') {
      const { issue } = JSON.parse((await body()).toString());
      state.puts.push(issue);
      if (issue.subject !== undefined && !options.ignoreSubject) state.issue.subject = issue.subject;
      for (const u of issue.uploads || []) {
        const up = state.uploads[Number(u.token.slice(4)) - 1];
        state.issue.attachments.push({ id: state.nextAttachment++, filename: u.filename, filesize: up.bytes.length, description: u.description });
      }
      if (issue.notes) state.issue.journals.push({ id: 900 + state.puts.length, user: { id: 7 }, notes: issue.notes, private_notes: false });
      state.issue.updated_on = `2026-01-02T00:00:0${state.puts.length}Z`;
      res.writeHead(204); return res.end();
    }
    const del = /^\/attachments\/(\d+)\.json$/.exec(url.pathname);
    if (del && req.method === 'DELETE') {
      state.deletes.push(Number(del[1]));
      if (options.rejectDelete) return json({}, options.rejectDelete);
      if (!options.ignoreDelete) state.issue.attachments = state.issue.attachments.filter(a => a.id !== Number(del[1]));
      res.writeHead(204); return res.end();
    }
    json({}, 404);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); return new Promise(r => server.close(r)); });
  const config = { baseUrl: `http://127.0.0.1:${server.address().port}/`, apiKey: 'fake', stateDir,
    timeoutMs: 2000, maxJsonBytes: 1000000, maxAttachmentBytes: 5000000, maxUploadBytes: 1000, timeZone: 'Asia/Almaty', maxPages: 100 };
  const service = new RedmineService(new RedmineClient(config));
  const file = join(root, 'отчёт.txt'); await writeFile(file, 'hello file');
  return { service, state, config, root, file };
}
const apply = (service, plan) => service.invoke('redmine_apply_change', { operation_id: plan.operation_id });

test('rename: draft has no side effect, apply sends subject once and verifies it', async t => {
  const { service, state } = await fixture(t);
  const plan = await service.invoke('redmine_prepare_rename_issue', { issue_id: 87, subject: '  Новый заголовок  ' });
  assert.equal(plan.state, 'prepared'); assert.deepEqual(plan.changes[0], { field: 'subject', before: 'Старый заголовок', after: 'Новый заголовок', label: undefined });
  assert.equal(state.puts.length, 0);
  const result = await apply(service, plan);
  assert.equal(result.state, 'applied'); assert.deepEqual(state.puts, [{ subject: 'Новый заголовок' }]);
  assert.equal((await apply(service, plan)).replayed, true); assert.equal(state.puts.length, 1);
});

test('rename: same subject is NO_CHANGES, ignored subject is verification_failed', async t => {
  const { service } = await fixture(t);
  await assert.rejects(service.invoke('redmine_prepare_rename_issue', { issue_id: 87, subject: 'Старый заголовок' }), { code: 'NO_CHANGES' });
  const ignoring = await fixture(t, { ignoreSubject: true });
  const plan = await ignoring.service.invoke('redmine_prepare_rename_issue', { issue_id: 87, subject: 'X', comment: '## Почему\n- уточнили' });
  const result = await apply(ignoring.service, plan);
  assert.equal(result.state, 'verification_failed'); assert.deepEqual(result.mismatches, ['subject']);
});

test('attach: prepare hashes file without uploading; apply uploads then PUTs token and verifies attachment', async t => {
  const { service, state, file } = await fixture(t);
  const plan = await service.invoke('redmine_prepare_attach_file', { issue_id: 87, file_path: file, description: 'Спецификация', comment: 'Приложил файл' });
  assert.equal(plan.file.filename, 'отчёт.txt'); assert.equal(plan.file.size, 10); assert.match(plan.file.sha256, /^[0-9a-f]{64}$/);
  assert.equal(state.uploads.length, 0); assert.equal(state.puts.length, 0);
  const result = await apply(service, plan);
  assert.equal(result.state, 'applied'); assert.equal(result.attachment_id, 500); assert.equal(result.journal_id, 901);
  assert.equal(state.uploads[0].bytes.toString(), 'hello file'); assert.equal(state.uploads[0].type, 'application/octet-stream');
  assert.deepEqual(state.puts[0], { notes: 'Приложил файл', uploads: [{ token: 'tok-1', filename: 'отчёт.txt', description: 'Спецификация' }] });
  await apply(service, plan); assert.equal(state.uploads.length, 1); assert.equal(state.puts.length, 1);
});

test('attach: file changed after prepare uploads nothing', async t => {
  const { service, state, file } = await fixture(t);
  const plan = await service.invoke('redmine_prepare_attach_file', { issue_id: 87, file_path: file, filename: 'renamed.txt' });
  await writeFile(file, 'tampered!!');
  const result = await apply(service, plan);
  assert.equal(result.state, 'rejected'); assert.equal(result.error.code, 'FILE_CHANGED');
  assert.equal(state.uploads.length, 0); assert.equal(state.puts.length, 0);
});

test('attach: rejected upload is "rejected" and issue untouched', async t => {
  const { service, state, file } = await fixture(t, { rejectUpload: 422 });
  const plan = await service.invoke('redmine_prepare_attach_file', { issue_id: 87, file_path: file });
  const result = await apply(service, plan);
  assert.equal(result.state, 'rejected'); assert.equal(result.error.code, 'HTTP_422'); assert.equal(state.puts.length, 0);
});

test('attach: relative, missing, oversized, .env, state-dir files and bad names refused before any draft', async t => {
  const { service, root, config } = await fixture(t);
  const big = join(root, 'big.bin'); await writeFile(big, Buffer.alloc(2000));
  const env = join(root, '.env'); await writeFile(env, 'REDMINE_API_KEY=secret');
  const { mkdir } = await import('node:fs/promises'); await mkdir(config.stateDir, { recursive: true });
  const inState = join(config.stateDir, 'x.json'); await writeFile(inState, '{}');
  const cases = [['relative.txt', 'INVALID_ARGUMENTS'], [join(root, 'missing.txt'), 'FILE_NOT_FOUND'], [root, 'INVALID_ARGUMENTS'],
    [big, 'TOO_LARGE'], [env, 'FILE_FORBIDDEN'], [inState, 'FILE_FORBIDDEN']];
  for (const [file_path, code] of cases) {
    await assert.rejects(service.invoke('redmine_prepare_attach_file', { issue_id: 87, file_path }), { code });
  }
  await assert.rejects(service.invoke('redmine_prepare_attach_file', { issue_id: 87, file_path: big, filename: 'a/b.txt' }), { code: 'INVALID_ARGUMENTS' });
});

test('delete: preview shows exact file and permanence; apply deletes once and verifies', async t => {
  const { service, state } = await fixture(t);
  await assert.rejects(service.invoke('redmine_prepare_delete_attachment', { issue_id: 87, attachment_id: 999 }), { code: 'NOT_FOUND' });
  const plan = await service.invoke('redmine_prepare_delete_attachment', { issue_id: 87, attachment_id: 41 });
  assert.equal(plan.attachment.filename, 'old.txt'); assert.equal(plan.attachment.author.name, 'Other'); assert.match(plan.irreversible_notice, /PERMANENT/);
  assert.equal(state.deletes.length, 0);
  const result = await apply(service, plan);
  assert.equal(result.state, 'applied'); assert.equal(result.deleted_attachment_id, 41); assert.deepEqual(state.deletes, [41]);
  await apply(service, plan); assert.equal(state.deletes.length, 1);
});

test('delete: concurrent change, HTTP rejection and ignored delete are not reported as success', async t => {
  const a = await fixture(t);
  const plan = await a.service.invoke('redmine_prepare_delete_attachment', { issue_id: 87, attachment_id: 41 });
  a.state.issue.subject = 'changed';
  assert.equal((await apply(a.service, plan)).error.code, 'CONFLICT'); assert.equal(a.state.deletes.length, 0);
  const b = await fixture(t, { rejectDelete: 403 });
  const r = await apply(b.service, await b.service.invoke('redmine_prepare_delete_attachment', { issue_id: 87, attachment_id: 41 }));
  assert.equal(r.state, 'rejected'); assert.equal(r.error.code, 'HTTP_403');
  const c = await fixture(t, { ignoreDelete: true });
  const v = await apply(c.service, await c.service.invoke('redmine_prepare_delete_attachment', { issue_id: 87, attachment_id: 41 }));
  assert.equal(v.state, 'verification_failed'); assert.deepEqual(v.mismatches, ['attachment']);
});

test('MCP lists the three new prepare tools', async t => {
  const { service } = await fixture(t); const server = createMcpServer(service);
  const client = new Client({ name: 'files-test', version: '1' });
  const [x, y] = InMemoryTransport.createLinkedPair(); await server.connect(x); await client.connect(y);
  t.after(async () => { await client.close(); await server.close(); });
  const names = (await client.listTools()).tools.map(tool => tool.name);
  for (const n of ['redmine_prepare_rename_issue', 'redmine_prepare_attach_file', 'redmine_prepare_delete_attachment']) assert.ok(names.includes(n), n);
});

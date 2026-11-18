import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { RedmineClient } from '../src/client.js';
import { RedmineService } from '../src/service.js';
import { createMcpServer } from '../src/mcp-server.js';
import { createHttpServer } from '../src/http-server.js';

async function fixture(t, options = {}) {
  const tempRoot = await realpath(tmpdir());
  const stateDir = await mkdtemp(join(tempRoot, 'redmine-write-test-'));
  const state = { writes: [], actor: 7, reads: 0, issue: { id: 87, subject: 'Test issue',
    project: { id: 3, name: 'SAP' }, tracker: { id: 1, name: 'Task' }, status: { id: 1, name: 'Новая' },
    priority: { id: 2, name: 'Средний' }, assigned_to: { id: 8, name: 'Other' },
    start_date: '2026-01-01', due_date: null, done_ratio: 0, updated_on: '2026-01-01T00:00:00Z',
    journals: [], attachments: [], custom_fields: [], allowed_statuses: [{ id: 1, name: 'Новая' }, { id: 2, name: 'В разработке' }] } };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const json = (data, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (url.pathname === '/users/current.json') return json({ user: { id: state.actor, login: 'dev', firstname: 'Developer' } });
    if (url.pathname === '/issue_statuses.json') return json({ issue_statuses: [...state.issue.allowed_statuses, { id: 99, name: 'Закрыта', is_closed: true }] });
    if (url.pathname === '/enumerations/issue_priorities.json') return json({ issue_priorities: [{ id: 2, name: 'Средний' }, { id: 3, name: 'Высокий' }] });
    if (url.pathname !== '/issues/87.json') return json({}, 404);
    if (req.method === 'GET') {
      state.reads++;
      if (options.failVerify && state.writes.length) return json({}, 503);
      return json({ issue: state.issue });
    }
    if (req.method !== 'PUT') return json({}, 405);
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const { issue: payload } = JSON.parse(Buffer.concat(chunks).toString());
    state.writes.push(payload);
    if (options.reject) return json({ errors: ['sensitive-server-body-secret'] }, options.reject);
    if (options.redirect) { res.writeHead(302, { Location: 'https://example.invalid/' }); res.end(); return; }
    if (options.delay) await new Promise(resolve => setTimeout(resolve, 50));
    if (!options.ignoreFields) {
      for (const [field, value] of Object.entries(payload)) {
        const mapping = { status_id: 'status', priority_id: 'priority', assigned_to_id: 'assigned_to' };
        if (mapping[field]) state.issue[mapping[field]] = { id: value, name: 'Updated' };
        else if (field !== 'notes') state.issue[field] = value === '' ? null : value;
      }
    }
    if (payload.notes && !options.ignoreNotes) state.issue.journals.push({ id: 100 + state.writes.length,
      user: { id: state.actor }, notes: payload.notes.replace(/\r?\n/g, '\r\n'), private_notes: false });
    state.issue.updated_on = '2026-01-02T00:00:00Z';
    if (options.dropAfterCommit) { req.socket.destroy(); return; }
    res.writeHead(204); res.end();
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    // Verify the exact resolved temporary directory before recursive cleanup on Windows.
    const actual = await realpath(stateDir);
    assert.equal(actual, resolve(stateDir));
    assert.ok(actual.startsWith(`${tempRoot}${sep}redmine-write-test-`));
    await rm(actual, { recursive: true });
  });
  const config = { baseUrl: `http://127.0.0.1:${server.address().port}/`, apiKey: 'fake-test-key', stateDir,
    timeoutMs: 2000, maxJsonBytes: 1000000, maxAttachmentBytes: 5000000, timeZone: 'Asia/Almaty', maxPages: 100 };
  const service = new RedmineService(new RedmineClient(config));
  return { service, state, config };
}

const draft = (service, args = {}) => service.invoke('redmine_prepare_change', { issue_id: 87, comment: 'Вопрос заказчику\nВторая строка', ...args });
const apply = (service, plan) => service.invoke('redmine_apply_change', { operation_id: plan.operation_id });

test('prepare makes exact reviewable draft, no PUT or notification side effect', async t => {
  const { service, state } = await fixture(t);
  const plan = await draft(service, { changes: { status: 'В разработке', assign_to_me: true, due_date: '2026-12-31', done_ratio: 25, priority: 'Высокий' } });
  assert.equal(plan.state, 'prepared'); assert.equal(plan.actor.id, 7); assert.equal(plan.comment_visibility, 'public');
  assert.deepEqual(plan.changes.map(d => d.field), ['status_id', 'priority_id', 'assigned_to_id', 'due_date', 'done_ratio']);
  assert.equal(state.writes.length, 0);
  const inspect = await service.invoke('redmine_get_operation', { operation_id: plan.operation_id });
  assert.equal(inspect.state, 'prepared'); assert.equal(inspect.comment, plan.comment);
});

test('combined change sent once, verified, replay survives a new service process', async t => {
  const { service, state, config } = await fixture(t);
  const plan = await draft(service, { changes: { status: 2, assign_to_me: true, due_date: '2026-12-31', done_ratio: 30, priority: 3 } });
  const result = await apply(service, plan);
  assert.equal(result.state, 'applied'); assert.equal(result.journal_id, 101);
  assert.deepEqual(state.writes[0], { status_id: 2, assigned_to_id: 7, due_date: '2026-12-31', done_ratio: 30, priority_id: 3, notes: plan.comment });
  const restarted = new RedmineService(new RedmineClient(config));
  const again = await apply(restarted, plan);
  assert.equal(again.replayed, true); assert.equal(again.state, 'applied'); assert.equal(state.writes.length, 1);
});

test('parallel clients share an exclusive permanent claim', async t => {
  const { service, state, config } = await fixture(t, { delay: true }); const plan = await draft(service);
  const another = new RedmineService(new RedmineClient(config));
  const results = await Promise.all([apply(service, plan), apply(another, plan)]);
  assert.equal(state.writes.length, 1);
  assert.ok(results.some(r => r.state === 'applied'));
  assert.ok(results.some(r => r.state === 'in_progress_or_uncertain' || r.replayed));
});

test('conflicting edit blocks all changes and comments', async t => {
  const { service, state } = await fixture(t); const plan = await draft(service);
  state.issue.description = 'Edited concurrently without timestamp precision';
  const result = await apply(service, plan);
  assert.equal(result.state, 'rejected'); assert.equal(result.error.code, 'CONFLICT'); assert.equal(state.writes.length, 0);
});

test('removed allowed transition is rechecked even when issue fingerprint unchanged', async t => {
  const { service, state } = await fixture(t); const plan = await draft(service, { changes: { status: 2 } });
  state.issue.allowed_statuses = [{ id: 1 }];
  assert.equal((await apply(service, plan)).error.code, 'TRANSITION_DENIED'); assert.equal(state.writes.length, 0);
});

test('role-disallowed status and invalid dates rejected before creating draft', async t => {
  const { service, state } = await fixture(t);
  await assert.rejects(draft(service, { changes: { status: 99 } }), { code: 'TRANSITION_DENIED' });
  await assert.rejects(draft(service, { changes: { due_date: '2026-02-30' } }), { code: 'INVALID_ARGUMENTS' });
  await assert.rejects(draft(service, { changes: { due_date: '2025-01-01' } }), { code: 'INVALID_DATES' });
  assert.equal(state.writes.length, 0);
});

test('null clears date; field-only update does not create a fabricated comment', async t => {
  const { service, state } = await fixture(t);
  const plan = await service.invoke('redmine_prepare_change', { issue_id: 87, changes: { start_date: null } });
  assert.equal((await apply(service, plan)).state, 'applied');
  assert.deepEqual(state.writes[0], { start_date: '' }); assert.equal(state.issue.journals.length, 0);
});

test('empty, private, destructive and unsupported updates are rejected', async t => {
  const { service, state } = await fixture(t);
  for (const args of [{ issue_id: 87 }, { issue_id: 87, comment: '   ' },
    { issue_id: 87, comment: 'private', private_notes: true },
    { issue_id: 87, changes: { subject: 'replacement' } },
    { issue_id: 87, changes: { done_ratio: 101 } },
    { issue_id: 87, changes: { assigned_to_id: 1 } }]) {
    await assert.rejects(service.invoke('redmine_prepare_change', args), { code: 'INVALID_ARGUMENTS' });
  }
  await assert.rejects(service.invoke('redmine_prepare_change', { issue_id: 87, changes: { done_ratio: 0 } }), { code: 'NO_CHANGES' });
  assert.equal(state.writes.length, 0);
});

test('expired plan rejected; actor change and credential changes cannot apply another plan', async t => {
  const { service, state, config } = await fixture(t); const plan = await draft(service);
  state.actor = 8;
  await assert.rejects(apply(service, plan), { code: 'ACTOR_CHANGED' });
  state.actor = 7;
  const otherKey = new RedmineService(new RedmineClient({ ...config, apiKey: 'different' }));
  await assert.rejects(apply(otherKey, plan), { code: 'OPERATION_NOT_FOUND' });
  const path = service.writes.store.path(plan.operation_id, 'plan.json');
  const record = JSON.parse(await readFile(path, 'utf8')); record.expires_at = '2000-01-01T00:00:00Z';
  await writeFile(path, JSON.stringify(record));
  assert.equal((await apply(service, plan)).error.code, 'EXPIRED'); assert.equal(state.writes.length, 0);
});

for (const code of [401, 403, 404, 409, 422, 429]) {
  test(`PUT ${code} is rejected, sanitized and never automatically retried`, async t => {
    const { service, state } = await fixture(t, { reject: code }); const plan = await draft(service);
    const result = await apply(service, plan);
    assert.equal(result.state, 'rejected'); assert.equal(result.error.code, `HTTP_${code}`);
    assert.ok(!JSON.stringify(result).includes('sensitive-server-body-secret'));
    await apply(service, plan); assert.equal(state.writes.length, 1);
  });
}

for (const option of ['dropAfterCommit', 'failVerify', 'redirect']) {
  test(`uncertain outcome (${option}) cannot cause duplicate comment on retry`, async t => {
    const { service, state, config } = await fixture(t, { [option]: true }); const plan = await draft(service);
    assert.equal((await apply(service, plan)).state, 'uncertain');
    const restarted = new RedmineService(new RedmineClient(config));
    assert.equal((await apply(restarted, plan)).state, 'uncertain'); assert.equal(state.writes.length, 1);
  });
}

test('HTTP 204 with silently ignored fields is not reported as success', async t => {
  const { service, state } = await fixture(t, { ignoreFields: true });
  const plan = await draft(service, { changes: { done_ratio: 25 } });
  const result = await apply(service, plan);
  assert.equal(result.state, 'verification_failed'); assert.deepEqual(result.mismatches, ['done_ratio']);
  assert.equal(state.issue.journals.length, 1);
  await apply(service, plan); assert.equal(state.writes.length, 1);
});

test('ignored comment and old identical comment cannot falsely verify a new write', async t => {
  const { service, state } = await fixture(t, { ignoreNotes: true });
  state.issue.journals.push({ id: 1, user: { id: 7 }, notes: 'same text' });
  const plan = await draft(service, { comment: 'same text' });
  const result = await apply(service, plan);
  assert.equal(result.state, 'verification_failed'); assert.deepEqual(result.mismatches, ['notes']);
});

test('crash after claim leaves permanent no-retry state', async t => {
  const { service, state } = await fixture(t); const plan = await draft(service);
  await service.writes.store.claim(plan.operation_id);
  assert.equal((await apply(service, plan)).state, 'in_progress_or_uncertain');
  assert.equal((await service.invoke('redmine_get_operation', { operation_id: plan.operation_id })).state, 'in_progress_or_uncertain');
  assert.equal(state.writes.length, 0);
});

test('storage failure before claim cannot send a write', async t => {
  const { service, state } = await fixture(t); const plan = await draft(service);
  service.writes.store.claim = async () => { throw new Error('Disk unavailable'); };
  await assert.rejects(apply(service, plan)); assert.equal(state.writes.length, 0);
});

test('storage failure after write reports uncertainty and permanent claim prevents retry', async t => {
  const { service, state } = await fixture(t); const plan = await draft(service);
  service.writes.store.finish = async () => { throw new Error('Disk full'); };
  await assert.rejects(apply(service, plan), { code: 'WRITE_UNCERTAIN' });
  assert.equal((await apply(service, plan)).state, 'in_progress_or_uncertain');
  assert.equal(state.writes.length, 1);
});

test('server 500 is uncertain, not a license to resend', async t => {
  const { service, state } = await fixture(t, { reject: 500 }); const plan = await draft(service);
  assert.equal((await apply(service, plan)).state, 'uncertain');
  await apply(service, plan); assert.equal(state.writes.length, 1);
});

test('CLI accepts UTF-8 JSON file with BOM and short operation ID without shell JSON quoting', async t => {
  const { config } = await fixture(t);
  const file = join(config.stateDir, 'request.json');
  await writeFile(file, '\uFEFF' + JSON.stringify({ issue_id: 87, comment: 'Кириллица и "кавычки"\nНовая строка' }));
  const env = { ...process.env, REDMINE_URL: 'https://example.test', REDMINE_API_KEY: '', REDMINE_API_KEY_FILE: '' };
  for (const args of [['prepare', `@${file}`], ['issue', '87'], ['apply', '12345678-1234-4123-8123-123456789abc'], ['operation', '12345678-1234-4123-8123-123456789abc']]) {
    await assert.rejects(promisify(execFile)(process.execPath, ['src/cli.js', ...args], { env }), error => {
      // Parsing succeeded; credentials deliberately absent to avoid any real API call.
      assert.equal(JSON.parse(error.stderr).error.code, 'CONFIG'); return true;
    });
  }
});

test('MCP exposes mutation annotations and supports prepare/apply with shared schemas', async t => {
  const { service, state } = await fixture(t); const server = createMcpServer(service);
  const client = new Client({ name: 'write-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a); await client.connect(b);
  t.after(async () => { await client.close(); await server.close(); });
  const tools = (await client.listTools()).tools;
  assert.equal(tools.find(t => t.name === 'redmine_apply_change').annotations.destructiveHint, true);
  const prepared = await client.callTool({ name: 'redmine_prepare_change', arguments: { issue_id: 87, comment: 'Explicitly requested test comment' } });
  assert.equal(prepared.isError, undefined); const plan = JSON.parse(prepared.content[0].text);
  assert.equal(state.writes.length, 0);
  const applied = await client.callTool({ name: 'redmine_apply_change', arguments: { operation_id: plan.operation_id } });
  assert.equal(applied.isError, undefined); assert.equal(JSON.parse(applied.content[0].text).state, 'applied');
  const next = await draft(service); state.issue.description = 'changed';
  const rejected = await client.callTool({ name: 'redmine_apply_change', arguments: { operation_id: next.operation_id } });
  assert.equal(rejected.isError, true);
});

test('local HTTP exposes prepare/apply and does not report conflict as HTTP success', async t => {
  const { service, state } = await fixture(t); const token = 'independent-local-http-token-123456789';
  const server = createHttpServer(service, token); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const call = (name, body) => fetch(`http://127.0.0.1:${server.address().port}/v1/tools/${name}`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const plan = await (await call('redmine_prepare_change', { issue_id: 87, comment: 'test' })).json();
  assert.equal(state.writes.length, 0); state.issue.done_ratio = 10;
  const result = await call('redmine_apply_change', { operation_id: plan.operation_id });
  assert.equal(result.status, 409); assert.equal((await result.json()).state, 'rejected');
});

test('Textile comment rejected before reading the issue or storing a draft; Markdown passes', async t => {
  const { service, state, config } = await fixture(t);
  const { readdir } = await import('node:fs/promises');
  const before = await readdir(config.stateDir, { recursive: true });
  for (const comment of ['h3. Итог\nТекст', 'Таблица\n|_. Поле |_. Значение |\n| a | b |', '  h2. Отступ']) {
    await assert.rejects(draft(service, { comment }), e => e.code === 'TEXTILE_MARKUP' && /Markdown/.test(e.message) && /Черновик не создан/.test(e.message));
  }
  assert.equal(state.reads, 0); assert.deepEqual(await readdir(config.stateDir, { recursive: true }), before);
  const plan = await draft(service, { comment: '## Итог\n\n1. Пункт\n- пункт\n\n**жирный**\n\n| Поле | Значение |\n|---|---|\n| a | b |\n\n```\nh2. пример в коде\n```' });
  assert.equal(plan.state, 'prepared'); assert.equal(state.writes.length, 0);
});

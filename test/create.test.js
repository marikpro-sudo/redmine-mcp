import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { RedmineClient } from '../src/client.js';
import { RedmineService } from '../src/service.js';
import { createMcpServer } from '../src/mcp-server.js';
import { createHttpServer } from '../src/http-server.js';
import { creationFields } from '../src/create-service.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const args = { tracker: 'Доработка', status: 'Закрыта', status_confirmed: true, subject: 'Изменён отчёт', description: 'Добавлен отбор. Проверен сценарий.',
  business_customer: 9, sap_module: 'FI', acceptance_criteria: 'Отбор работает', dev_transports: 'DEVK900001',
  test_system: 'QAS 100', test_result: 'Проверен отбор' };
const prepare = (s, more = {}) => s.invoke('redmine_prepare_create_issue', { ...args, ...more });
const apply = (s, p) => s.invoke('redmine_apply_create_issue', { operation_id: p.operation_id });
async function fixture(t, options = {}) {
  const root = await realpath(tmpdir()); const stateDir = await mkdtemp(join(root, 'redmine-create-test-'));
  const fields = Object.entries(creationFields).map(([key, [name, format]], index) => ({ id: index + 10, name, format,
    writable: true, required: key !== 'ai_participation', multiple: false,
    options: key === 'business_customer' ? [{ value: '9', label: 'Заказчик' }] : key === 'sap_module' ? [{ value: 'FI', label: 'FI' }] :
      key === 'ai_participation' ? [{ value: 'ИИ помогал', label: 'ИИ помогал' }] : [] }));
  const statuses = [{ id: 99, name: 'Закрыта', is_closed: true, default_done_ratio: 100 },
    { id: 1, name: 'Новая', is_closed: false, default_done_ratio: 0 }, { id: 2, name: 'В разработке', is_closed: false, default_done_ratio: 40 }];
  const tracker = { id: 3, name: 'Доработка', can_create: true, can_assign_self: true, initial_statuses: structuredClone(statuses),
    writable_core: ['subject', 'description', 'assigned_to_id', 'status_id', 'done_ratio'], required_attributes: ['assigned_to_id', ...fields.filter(f => f.required).map(f => String(f.id))], fields };
  const state = { actor: 7, posts: [], contexts: [], statuses, context: { schema_version: 2, actor_id: 7, project: { id: 2, identifier: 'sap', name: 'SAP' },
    done_ratio_mode: 'issue_field', trackers: [tracker, ...['Новая разработка', 'Ошибка', 'Консультация', 'Перенос SAP'].map((name, i) => ({ ...structuredClone(tracker), id: 4 + i, name }))] } };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost'); const path = url.pathname;
    const json = (data, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (path === '/users/current.json') return json({ user: { id: state.actor, firstname: 'Разработчик' } });
    if (path.endsWith('/completed-work/context.json')) {
      state.contexts.push(url.searchParams.get('status'));
      const ctx = structuredClone(state.context);
      for (const t of ctx.trackers) {
        t.selected_status = t.initial_statuses.find(s => String(s.id) === url.searchParams.get('status') || s.name === url.searchParams.get('status')) || null;
        if (!t.selected_status) { t.fields = []; t.required_attributes = []; t.writable_core = []; }
        else if (t.selected_status.id === 1 && t.name !== 'Перенос SAP') {
          t.fields.forEach(f => { f.required = f.name === 'Модуль SAP'; }); t.required_attributes = ['10'];
        }
      }
      return json(ctx, options.contextMissing ? 404 : 200);
    }
    if (path === '/issue_statuses.json') return json({ issue_statuses: state.statuses.map(s => ({ ...s, is_closed: options.notClosed ? false : s.is_closed })) });
    if (path === '/issues/101.json' && req.method === 'GET') return json({ issue: state.issue }, options.failVerify || 200);
    if (path !== '/issues.json' || req.method !== 'POST') return json({}, 404);
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const { issue: p } = JSON.parse(Buffer.concat(chunks)); state.posts.push(p);
    if (options.reject) return json({ errors: ['secret body'] }, options.reject);
    if (options.redirect) { res.writeHead(302, { Location: 'https://example.invalid/' }); return res.end(); }
    state.issue = { id: 101, subject: p.subject, description: p.description.replace(/\n/g, '\r\n'), done_ratio: p.done_ratio,
      project: { id: p.project_id }, tracker: { id: p.tracker_id }, assigned_to: { id: p.assigned_to_id },
      status: { id: options.ignoreStatus ? 1 : p.status_id, name: options.ignoreStatus ? 'Новая' : state.statuses.find(s => s.id === p.status_id)?.name }, custom_fields: p.custom_fields };
    if (options.ignoreField) state.issue.custom_fields = [];
    if (options.drop) return req.socket.destroy();
    if (options.badId) return json({ issue: {} }, 201);
    return json({ issue: state.issue }, 201);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    const actual = await realpath(stateDir); assert.ok(actual.startsWith(`${root}${sep}redmine-create-test-`));
    await rm(actual, { recursive: true });
  });
  const config = { baseUrl: `http://127.0.0.1:${server.address().port}/`, apiKey: 'fake', stateDir, defaultProject: 'sap', timeoutMs: 2000, maxJsonBytes: 1000000 };
  return { service: new RedmineService(new RedmineClient(config)), config, state };
}

for (const tracker of ['Доработка', 'Новая разработка']) test(`closed creation: ${tracker}, exact facts, 100%, verified once`, async t => {
  const { service, config, state } = await fixture(t); const p = await prepare(service, { tracker });
  assert.equal(p.done_ratio, 100); assert.equal(state.posts.length, 0);
  assert.equal((await service.invoke('redmine_get_operation', { operation_id: p.operation_id })).kind, 'create_issue');
  const result = await apply(service, p); assert.equal(result.state, 'applied'); assert.equal(result.issue_id, 101);
  assert.equal(state.posts[0].assigned_to_id, 7); assert.equal(state.posts[0].done_ratio, 100);
  for (const key of ['priority_id', 'start_date', 'due_date', 'estimated_hours']) assert.ok(!(key in state.posts[0]));
  assert.equal((await apply(new RedmineService(new RedmineClient(config)), p)).replayed, true);
  assert.equal(state.posts.length, 1);
});

test('missing facts and unsupported fields are rejected before POST', async t => {
  const { service, state } = await fixture(t);
  for (const key of ['business_customer', 'sap_module', 'test_result', 'acceptance_criteria', 'dev_transports', 'test_system']) {
    await assert.rejects(prepare(service, { [key]: undefined }), { code: key === 'sap_module' ? 'INVALID_ARGUMENTS' : 'MISSING_FIELDS' });
  }
  await assert.rejects(prepare(service, { done_ratio: 50 }), { code: 'INVALID_PROGRESS' });
  await assert.rejects(prepare(service, { sap_module: 'Unknown' }), { code: 'INVALID_FIELD_VALUE' });
  assert.equal(state.posts.length, 0);
});

test('ambiguous customers require an exact offered account ID', async t => {
  const { service, state } = await fixture(t);
  state.context.trackers[0].fields[1].options.push({ value: '10', label: 'Заказчик' });
  await assert.rejects(prepare(service, { business_customer: 'Заказчик' }), { code: 'CUSTOMER_UNRESOLVED' });
  const p = await prepare(service, { business_customer: 10 });
  assert.equal(p.custom_fields.find(f => f.name === 'Бизнес-заказчик').value, '10');
});

test('missing plugin fails explicitly, no task-derived field guesses', async t => {
  const { service, state } = await fixture(t, { contextMissing: true });
  await assert.rejects(prepare(service), { code: 'CONTEXT_UNAVAILABLE' }); assert.equal(state.posts.length, 0);
});

for (const [name, mutate, code] of [
  ['no initial closed status', t => t.initial_statuses = [], 'TRANSITION_DENIED'],
  ['create permission missing', t => t.can_create = false, 'TRANSITION_DENIED'],
  ['self assignment forbidden', t => t.can_assign_self = false, 'ASSIGNEE_DENIED'],
  ['field readonly', t => t.fields[0].writable = false, 'FIELDS_UNAVAILABLE'],
  ['field duplicate', t => t.fields.push({ ...t.fields[0], id: 77 }), 'FIELDS_UNAVAILABLE'],
  ['extra required field', t => t.required_attributes.push('due_date'), 'UNSUPPORTED_REQUIRED_FIELDS']
]) test(name, async t => {
  const { service, state } = await fixture(t); mutate(state.context.trackers[0]);
  await assert.rejects(prepare(service), { code }); assert.equal(state.posts.length, 0);
});

test('status-derived progress requires server closed status default 100', async t => {
  const { service, state } = await fixture(t); state.context.done_ratio_mode = 'issue_status';
  state.context.trackers[0].initial_statuses[0].default_done_ratio = 80;
  await assert.rejects(prepare(service), { code: 'FIELDS_UNAVAILABLE' });
  state.context.trackers[0].initial_statuses[0].default_done_ratio = 100;
  assert.equal((await apply(service, await prepare(service))).state, 'applied');
});

test('permission and mapping changes after preparation prevent POST', async t => {
  const { service, state } = await fixture(t); const p = await prepare(service);
  state.context.trackers[0].initial_statuses = [];
  assert.equal((await apply(service, p)).state, 'rejected'); assert.equal(state.posts.length, 0);
});
test('changed field IDs do not silently retarget prepared values', async t => {
  const { service, state } = await fixture(t); const p = await prepare(service);
  state.context.trackers[0].fields[0].id = 80;
  state.context.trackers[0].required_attributes = ['assigned_to_id'];
  assert.equal((await apply(service, p)).error.code, 'CONTEXT_CHANGED'); assert.equal(state.posts.length, 0);
});

test('expiry and actor check prevent sending; wrong apply endpoint cannot claim operation', async t => {
  const { service, state } = await fixture(t); const p = await prepare(service);
  await assert.rejects(service.invoke('redmine_apply_change', { operation_id: p.operation_id }), { code: 'OPERATION_KIND' });
  state.actor = 8; await assert.rejects(apply(service, p), { code: 'ACTOR_CHANGED' }); state.actor = 7;
  const path = service.writes.store.path(p.operation_id, 'plan.json'); const record = JSON.parse(await readFile(path));
  record.expires_at = '2000-01-01T00:00:00Z'; await writeFile(path, JSON.stringify(record));
  assert.equal((await apply(service, p)).error.code, 'EXPIRED'); assert.equal(state.posts.length, 0);
});

test('parallel creation across clients sends only one POST', async t => {
  const { service, config, state } = await fixture(t); const p = await prepare(service);
  const results = await Promise.all([apply(service, p), apply(new RedmineService(new RedmineClient(config)), p)]);
  assert.ok(results.some(r => r.state === 'applied')); assert.equal(state.posts.length, 1);
});

for (const reject of [401, 403, 404, 409, 422, 429, 500]) test(`POST ${reject}: sanitized and never resent`, async t => {
  const { service, state } = await fixture(t, { reject }); const p = await prepare(service);
  const r = await apply(service, p); assert.equal(r.state, reject === 500 ? 'uncertain' : 'rejected');
  assert.ok(!JSON.stringify(r).includes('secret body')); await apply(service, p); assert.equal(state.posts.length, 1);
});
for (const options of [{ drop: true }, { badId: true }, { failVerify: 403 }, { redirect: true }]) test(`uncertain creation ${JSON.stringify(options)}`, async t => {
  const { service, state } = await fixture(t, options); const p = await prepare(service);
  const r = await apply(service, p); assert.equal(r.state, 'uncertain');
  if (options.failVerify) assert.equal(r.issue_id, 101);
  await apply(service, p); assert.equal(state.posts.length, 1);
});
for (const options of [{ ignoreStatus: true }, { ignoreField: true }, { notClosed: true }]) test(`verify ignored values ${JSON.stringify(options)}`, async t => {
  const { service } = await fixture(t, options); const r = await apply(service, await prepare(service));
  assert.equal(r.state, 'verification_failed'); assert.equal(r.issue_id, 101); assert.ok(r.url.endsWith('/issues/101'));
});

test('claim survives interrupted execution; failed result storage does not allow retry', async t => {
  const { service, state, config } = await fixture(t); const p = await prepare(service);
  await service.writes.store.claim(p.operation_id); assert.equal((await apply(service, p)).state, 'in_progress_or_uncertain');
  const p2 = await prepare(service); service.writes.store.finish = async () => { throw new Error('disk'); };
  const result = await apply(service, p2); assert.equal(result.state, 'uncertain'); assert.equal(result.issue_id, 101);
  assert.equal((await apply(new RedmineService(new RedmineClient(config)), p2)).state, 'in_progress_or_uncertain');
  assert.equal(state.posts.length, 1);
});

test('creation available through MCP and HTTP, non-success states signalled', async t => {
  const { service } = await fixture(t, { ignoreStatus: true }); const mcp = createMcpServer(service);
  const client = new Client({ name: 'create-test', version: '1' }); const [a, b] = InMemoryTransport.createLinkedPair();
  await mcp.connect(a); await client.connect(b); t.after(async () => { await client.close(); await mcp.close(); });
  const p = JSON.parse((await client.callTool({ name: 'redmine_prepare_create_issue', arguments: args })).content[0].text);
  assert.equal((await client.callTool({ name: 'redmine_apply_create_issue', arguments: { operation_id: p.operation_id } })).isError, true);
  const token = 't'.repeat(40); const http = createHttpServer(service, token); http.listen(0, '127.0.0.1'); await once(http, 'listening');
  t.after(() => { http.closeAllConnections(); http.close(); });
  const response = await fetch(`http://127.0.0.1:${http.address().port}/v1/tools/redmine_apply_create_issue`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ operation_id: p.operation_id }) });
  assert.equal(response.status, 502); assert.equal((await response.json()).state, 'verification_failed');
});

test('CLI prepare/apply across processes uses the same operation journal and signals failure', async t => {
  const { config, state } = await fixture(t, { ignoreStatus: true });
  const preload = join(config.stateDir, 'mock-fetch.mjs');
  await writeFile(preload, `const original = globalThis.fetch; globalThis.fetch = (url, options) => original(String(url).replace('https://example.test/', ${JSON.stringify(config.baseUrl)}), options);`);
  const input = join(config.stateDir, 'input.json'); await writeFile(input, '\uFEFF' + JSON.stringify(args));
  const env = { ...process.env, REDMINE_URL: 'https://example.test', REDMINE_API_KEY: 'fake', REDMINE_PROJECT: 'sap', REDMINE_STATE_DIR: config.stateDir };
  const run = (...args) => promisify(execFile)(process.execPath, ['--import', pathToFileURL(preload).href, 'src/cli.js', ...args], { env });
  const context = JSON.parse((await run('creation-context')).stdout); assert.equal(context.project.id, 2);
  const p = JSON.parse((await run('prepare-create', `@${input}`)).stdout); assert.equal(state.posts.length, 0);
  for (let attempt = 0; attempt < 2; attempt++) await assert.rejects(run('apply-create', p.operation_id), error => {
    assert.equal(error.code, 1); assert.equal(JSON.parse(error.stdout).state, 'verification_failed'); return true;
  });
  assert.equal(state.posts.length, 1);
  assert.equal(JSON.parse((await run('operation', p.operation_id)).stdout).issue_id, 101);
});

test('every creation requires an explicit status and the recorded answer to the status question', async t => {
  const { service, state } = await fixture(t);
  for (const more of [{ status: undefined }, { status_confirmed: undefined }, { status_confirmed: false }]) {
    await assert.rejects(prepare(service, more), { code: 'INVALID_ARGUMENTS' });
  }
  assert.equal(state.contexts.length, 0); assert.equal(state.posts.length, 0);
});

for (const tracker of ['Ошибка', 'Доработка', 'Новая разработка', 'Консультация', 'Перенос SAP']) {
  test(`selected open status is supported: ${tracker}`, async t => {
    const { service, state } = await fixture(t);
    const p = await prepare(service, { tracker, status: 'В разработке', done_ratio: 35 });
    assert.equal(p.status, 'В разработке'); assert.equal(p.done_ratio, 35);
    assert.equal((await apply(service, p)).state, 'applied'); assert.equal(state.posts[0].status_id, 2);
    assert.deepEqual(state.contexts, ['В разработке', '2']);
  });
}

test('new task asks only required facts, default open progress is zero', async t => {
  const { service, state } = await fixture(t);
  const p = await prepare(service, { status: 'Новая', acceptance_criteria: undefined, dev_transports: undefined, test_system: undefined, test_result: undefined });
  assert.equal(p.done_ratio, 0); assert.equal((await apply(service, p)).state, 'applied');
  assert.equal(state.posts[0].custom_fields.length, 3); // module, customer, default AI participation
});

test('manager uses own account and the same status confirmation rules', async t => {
  const { service, state } = await fixture(t); state.actor = 25; state.context.actor_id = 25;
  const p = await prepare(service, { status: 1 }); assert.equal(p.assigned_to.id, 25);
  assert.equal((await apply(service, p)).state, 'applied'); assert.equal(state.posts[0].assigned_to_id, 25);
});

test('old server schema fails safely without sending a task', async t => {
  const { service, state } = await fixture(t); state.context.schema_version = 1;
  await assert.rejects(prepare(service), { code: 'SERVER_UPGRADE_REQUIRED' }); assert.equal(state.posts.length, 0);
});

test('unapplied old closed-only drafts require a fresh status answer', async t => {
  const { service, state } = await fixture(t); const p = await prepare(service);
  const path = service.writes.store.path(p.operation_id, 'plan.json'); const record = JSON.parse(await readFile(path));
  delete record.input.status; delete record.input.status_confirmed; await writeFile(path, JSON.stringify(record));
  assert.equal((await apply(service, p)).error.code, 'STATUS_CONFIRMATION_REQUIRED'); assert.equal(state.posts.length, 0);
});

test('selected status must exist in effective initial transitions', async t => {
  const { service, state } = await fixture(t);
  await assert.rejects(prepare(service, { status: 'Unknown' }), { code: 'TRANSITION_DENIED' });
  assert.equal(state.posts.length, 0);
});

test('status-derived open progress is taken from server, conflicting explicit value is rejected', async t => {
  const { service } = await fixture(t);
  const ctx = await service.creations.context('sap', 2); ctx.done_ratio_mode = 'issue_status';
  const actor = await service.me();
  assert.equal(service.creations.payload({ ...args, status: 2 }, ctx, actor).done_ratio, 40);
  assert.throws(() => service.creations.payload({ ...args, status: 2, done_ratio: 60 }, ctx, actor), { code: 'FIELDS_UNAVAILABLE' });
});

test('transfer-specific required fields supplied by context IDs, no nonexistent customer field', async t => {
  const { service, state } = await fixture(t);
  const transfer = state.context.trackers.find(t => t.name === 'Перенос SAP');
  transfer.fields = [transfer.fields[0], { id: 30, name: 'Исходная заявка Redmine', format: 'int', writable: true, required: true, multiple: false, options: [] },
    { id: 31, name: 'Целевая система и мандант', format: 'string', writable: true, required: true, multiple: false, options: [] }];
  transfer.required_attributes = ['10', '30', '31'];
  const input = { tracker: 'Перенос SAP', status: 1, business_customer: undefined, acceptance_criteria: undefined,
    dev_transports: undefined, test_system: undefined, test_result: undefined };
  await assert.rejects(prepare(service, input), { code: 'MISSING_FIELDS' });
  await assert.rejects(prepare(service, { ...input, custom_fields: [{ id: 30, value: 'abc' }] }), { code: 'INVALID_FIELD_VALUE' });
  const p = await prepare(service, { ...input, custom_fields: [{ id: 30, value: '87' }, { id: 31, value: 'PRD 100' }] });
  assert.equal((await apply(service, p)).state, 'applied'); assert.equal(state.posts[0].custom_fields.length, 3);
});

test('generic fields respect visibility, read-only, offered values, multiplicity and duplicate aliases', async t => {
  const { service, state } = await fixture(t);
  await assert.rejects(prepare(service, { custom_fields: [{ id: 999, value: 'hidden' }] }), { code: 'FIELDS_UNAVAILABLE' });
  await assert.rejects(prepare(service, { custom_fields: [{ id: 10, value: 'FI' }] }), { code: 'DUPLICATE_FIELD' });
  const field = { id: 40, name: 'Соисполнители', format: 'user', writable: true, required: false, multiple: true,
    options: [{ value: '7', label: 'Dev' }, { value: '9', label: 'Customer' }] };
  state.context.trackers[0].fields.push(field);
  await assert.rejects(prepare(service, { custom_fields: [{ id: 40, value: '7' }] }), { code: 'INVALID_FIELD_VALUE' });
  await assert.rejects(prepare(service, { custom_fields: [{ id: 40, value: ['999'] }] }), { code: 'INVALID_FIELD_VALUE' });
  field.writable = false;
  await assert.rejects(prepare(service, { custom_fields: [{ id: 40, value: ['7'] }] }), { code: 'FIELDS_UNAVAILABLE' });
  field.writable = true;
  const p = await prepare(service, { custom_fields: [{ id: 40, value: ['9', '7'] }] });
  assert.equal((await apply(service, p)).state, 'applied');
});

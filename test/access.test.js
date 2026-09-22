import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadConfig, safeError } from '../src/config.js';
import { RedmineClient } from '../src/client.js';
import { RedmineService } from '../src/service.js';
import { createMcpServer } from '../src/mcp-server.js';
import { createHttpServer } from '../src/http-server.js';

const run = promisify(execFile);
const key = 'test-secret-never-return';
const statusList = [{ id: 1, name: 'Новая', is_closed: false }, { id: 2, name: 'В разработке', is_closed: false }, { id: 99, name: 'Архив', is_closed: true }];
const priorityList = [{ id: 3, name: 'Высокий', active: true }, { id: 2, name: 'Средний', active: true }];
const tasks = Array.from({ length: 205 }, (_, n) => ({ id: n + 1, subject: `Разработка ${n + 1}`,
  project: { id: 3, name: 'SAP' }, status: statusList[n % 3], priority: priorityList[n % 2],
  assigned_to: { id: n % 2 ? 8 : 7, name: 'Developer' }, due_date: n % 4 ? '2020-01-01' : null,
  custom_fields: [{ id: 12, name: 'Соисполнители', value: n % 2 ? ['7', '9'] : ['8'] }] }));

async function fixture(t, options = {}) {
  const requests = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    requests.push({ method: req.method, path: url.pathname, params: Object.fromEntries(url.searchParams), key: req.headers['x-redmine-api-key'] });
    const json = (data, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (options.status) return json({ error: key }, options.status);
    if (options.redirect) { res.writeHead(302, { Location: 'https://example.invalid/' }); res.end(); return; }
    if (options.html) { res.end('<html>Login</html>'); return; }
    if (url.pathname === '/users/current.json') return json({ user: { id: 7, login: 'dev', firstname: 'Дулат', lastname: 'Примов', api_key: key, mail: 'private@example.test', secret: key } });
    if (url.pathname === '/issue_statuses.json') return json({ issue_statuses: statusList });
    if (url.pathname === '/enumerations/issue_priorities.json') return json({ issue_priorities: priorityList });
    if (url.pathname === '/projects/sap-development.json' || url.pathname === '/projects/3.json') return json({ project: { id: 3 } });
    if (url.pathname === '/projects.json') return json({ projects: [{ id: 3, identifier: 'sap-development', name: 'SAP' }], offset: 0, total_count: 1 });
    if (url.pathname === '/issues.json') {
      let rows = structuredClone(tasks); const q = url.searchParams;
      if (q.get('status_id') === 'open') rows = rows.filter(i => !i.status.is_closed);
      else if (q.get('status_id') === 'closed') rows = rows.filter(i => i.status.is_closed);
      else if (q.get('status_id') !== '*') rows = rows.filter(i => String(i.status.id) === q.get('status_id'));
      if (q.has('assigned_to_id')) rows = rows.filter(i => String(i.assigned_to.id) === q.get('assigned_to_id'));
      if (q.has('priority_id')) rows = rows.filter(i => String(i.priority.id) === q.get('priority_id'));
      if (options.noFields) rows.forEach(i => { i.custom_fields = []; });
      const offset = Number(q.get('offset')); const total = rows.length;
      const page = rows.slice(options.duplicate ? 0 : offset, (options.duplicate ? 0 : offset) + 37); // server clamps requested page size
      return json({ issues: options.emptyPage && offset ? [] : page, offset,
        total_count: total + (options.changing && offset ? 1 : 0), limit: 37 });
    }
    if (url.pathname === '/issues/999.json') return json({ error: 'Hidden issue' }, 404);
    if (url.pathname === '/issues/1.json') return json({ issue: { ...tasks[0], description: 'Описание',
      journals: [{ id: 2, created_on: '2026-09-23T00:00:00Z', user: { id: 8, name: 'Заказчик' }, notes: 'Уточнение' }, { id: 1, created_on: '2026-09-22T00:00:00Z', notes: 'Начало' }],
      attachments: [{ id: 5, filename: '../test.txt', content_type: options.binary ? 'application/pdf' : 'text/plain', filesize: options.large ? 6000000 : 4,
        content_url: options.external ? 'https://evil.invalid/steal' : `http://127.0.0.1:${server.address().port}/attachments/download/5/test.txt` }] } });
    if (url.pathname === '/attachments/download/5/test.txt') { res.end(options.binary ? Buffer.from([0, 255, 2]) : Buffer.from('Привет')); return; }
    json({}, 404);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const config = { baseUrl: `http://127.0.0.1:${server.address().port}/`, apiKey: key,
    defaultProject: 'sap-development', timeZone: 'Asia/Almaty', timeoutMs: 2000,
    maxPages: 100, maxJsonBytes: 1000000, maxAttachmentBytes: 5 * 1024 * 1024 };
  const client = new RedmineClient(config);
  return { service: new RedmineService(client), client, requests, config };
}

test('configuration rejects unsafe addresses and missing credentials', async () => {
  for (const url of ['http://example.org', 'https://user:pw@example.org', 'https://example.org/?key=bad']) {
    await assert.rejects(loadConfig({ REDMINE_URL: url, REDMINE_API_KEY: key }), { code: 'CONFIG' });
  }
  await assert.rejects(loadConfig({ REDMINE_URL: 'https://example.org' }), { code: 'CONFIG' });
  await assert.rejects(loadConfig({ REDMINE_URL: 'https://example.org', REDMINE_API_KEY: key, REDMINE_TIME_ZONE: 'bad-zone' }), { code: 'CONFIG' });
  const c = await loadConfig({ REDMINE_URL: 'https://example.org/redmine/', REDMINE_API_KEY: key });
  assert.equal(c.baseUrl, 'https://example.org/redmine/');
});

test('identity excludes API key and unrelated personal fields', async t => {
  const { service } = await fixture(t);
  assert.deepEqual(await service.invoke('redmine_me'), { id: 7, login: 'dev', name: 'Дулат Примов' });
});

test('default list is my open tasks, complete despite server page clamp, GET only', async t => {
  const { service, requests } = await fixture(t);
  const result = await service.invoke('redmine_list_issues');
  const expected = tasks.filter(i => i.assigned_to.id === 7 && !i.status.is_closed);
  assert.deepEqual(result.issues.map(i => i.id), expected.map(i => i.id));
  assert.equal(result.total, expected.length); assert.equal(result.complete, true);
  assert.ok(requests.filter(r => r.path === '/issues.json').length > 1);
  assert.ok(requests.every(r => r.method === 'GET' && r.key === key));
  assert.equal(requests.find(r => r.path === '/issues.json').params.subproject_id, '!*');
  assert.ok(!JSON.stringify(result).includes(key));
});

test('exact status/priority names, project ID and subject filter', async t => {
  const { service } = await fixture(t);
  const result = await service.invoke('redmine_list_issues', { project: '3', status: 'В разработке', priority: 'Высокий', subject: 'Разработка 1' });
  assert.ok(result.total > 0);
  assert.ok(result.issues.every(i => i.status.id === 2 && i.priority.id === 3 && i.subject.includes('Разработка 1')));
  await assert.rejects(service.invoke('redmine_list_issues', { status: 'Опечатка' }), { code: 'INVALID_FILTER' });
});

test('collaborators are separate from primary assignee and scan all pages', async t => {
  const { service } = await fixture(t);
  const result = await service.invoke('redmine_list_issues', { relation: 'collaborator' });
  assert.deepEqual(result.issues.map(i => i.id), tasks.filter(i => i.assigned_to.id === 8 && !i.status.is_closed).map(i => i.id));
});

test('unavailable collaborator field does not silently mean no assignments', async t => {
  const { service } = await fixture(t, { noFields: true });
  await assert.rejects(service.invoke('redmine_list_issues', { relation: 'collaborator' }), { code: 'FIELD_UNAVAILABLE' });
});

test('overdue excludes closed and undated tasks, based on status flag', async t => {
  const { service } = await fixture(t);
  const result = await service.invoke('redmine_list_issues', { relation: 'all', status: '*', overdue: true });
  assert.deepEqual(result.issues.map(i => i.id), tasks.filter(i => !i.status.is_closed && i.due_date).map(i => i.id));
});

for (const [option, code] of [['changing', 'CHANGED_DURING_READ'], ['duplicate', 'CHANGED_DURING_READ'], ['emptyPage', 'BAD_RESPONSE']]) {
  test(`pagination fails explicitly: ${option}`, async t => {
    const { service } = await fixture(t, { [option]: true });
    await assert.rejects(service.invoke('redmine_list_issues', { relation: 'all', status: '*' }), { code });
  });
}

test('page safety cap gives error, never partial success', async t => {
  const { service, config } = await fixture(t); config.maxPages = 1;
  await assert.rejects(service.invoke('redmine_list_issues'), { code: 'LIMIT' });
});

test('issue includes sorted history and attachment metadata; hidden issue stays hidden', async t => {
  const { service } = await fixture(t);
  const issue = await service.invoke('redmine_get_issue', { issue_id: 1 });
  assert.deepEqual(issue.journals.map(j => j.id), [1, 2]); assert.equal(issue.description, 'Описание');
  assert.equal(issue.attachments[0].id, 5); assert.equal(issue.attachments[0].content_url, undefined);
  await assert.rejects(service.invoke('redmine_get_issue', { issue_id: 999 }), { code: 'HTTP_404' });
});

test('attachment read verifies issue membership and returns original UTF-8', async t => {
  const { service } = await fixture(t);
  const attachment = await service.invoke('redmine_read_attachment', { issue_id: 1, attachment_id: 5 });
  assert.equal(attachment.encoding, 'utf-8'); assert.equal(attachment.content, 'Привет');
  await assert.rejects(service.invoke('redmine_read_attachment', { issue_id: 1, attachment_id: 6 }), { code: 'NOT_FOUND' });
});

test('binary attachment uses lossless base64', async t => {
  const { service } = await fixture(t, { binary: true });
  const attachment = await service.invoke('redmine_read_attachment', { issue_id: 1, attachment_id: 5 });
  assert.equal(attachment.encoding, 'base64'); assert.deepEqual(Buffer.from(attachment.content, 'base64'), Buffer.from([0, 255, 2]));
});

for (const [option, code] of [['external', 'UNSAFE_URL'], ['large', 'TOO_LARGE']]) {
  test(`attachment rejects ${option} before downloading`, async t => {
    const { service, requests } = await fixture(t, { [option]: true });
    await assert.rejects(service.invoke('redmine_read_attachment', { issue_id: 1, attachment_id: 5 }), { code });
    assert.equal(requests.length, 1);
  });
}

test('redirects, HTML and API errors are sanitized', async t => {
  for (const [options, code] of [[{ redirect: true }, 'HTTP_302'], [{ html: true }, 'BAD_RESPONSE'], [{ status: 403 }, 'HTTP_403'], [{ status: 401 }, 'HTTP_401']]) {
    const { service } = await fixture(t, options);
    await assert.rejects(service.invoke('redmine_me'), error => { assert.equal(error.code, code); assert.ok(!error.message.includes(key)); return true; });
  }
  assert.ok(!JSON.stringify(safeError(new Error(key))).includes(key));
});

test('streamed response size cap works without Content-Length', async t => {
  const { service, config } = await fixture(t); config.maxJsonBytes = 8;
  await assert.rejects(service.invoke('redmine_me'), { code: 'TOO_LARGE' });
});

test('invalid arguments and write operations never reach Redmine', async t => {
  const { service, requests } = await fixture(t);
  await assert.rejects(service.invoke('redmine_get_issue', { issue_id: '../1' }), { code: 'INVALID_ARGUMENTS' });
  await assert.rejects(service.invoke('redmine_list_issues', { assigned_to_id: 9 }), { code: 'INVALID_ARGUMENTS' });
  await assert.rejects(service.invoke('redmine_update_issue', { issue_id: 1 }), { code: 'UNKNOWN_TOOL' });
  assert.equal(requests.length, 0);
});

test('MCP SDK handshake, discovery, defaults, tool call and errors', async t => {
  const { service } = await fixture(t);
  const server = createMcpServer(service); const client = new Client({ name: 'test-harness', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  t.after(async () => { await client.close(); await server.close(); });
  const { tools } = await client.listTools(); assert.equal(tools.length, 8);
  assert.equal(tools.find(tool => tool.name === 'redmine_apply_change').annotations.readOnlyHint, false);
  assert.ok(tools.filter(tool => !['redmine_apply_change', 'redmine_prepare_change'].includes(tool.name)).every(tool => tool.annotations.readOnlyHint));
  assert.ok(!(tools.find(t => t.name === 'redmine_list_issues').inputSchema.required || []).includes('status'));
  const result = await client.callTool({ name: 'redmine_list_issues', arguments: {} });
  assert.equal(result.isError, undefined); assert.ok(JSON.parse(result.content[0].text).total > 0);
  const hidden = await client.callTool({ name: 'redmine_get_issue', arguments: { issue_id: 999 } });
  assert.equal(hidden.isError, true);
});

test('real stdio process negotiates MCP and exposes tools', async t => {
  const transport = new StdioClientTransport({ command: process.execPath, args: ['src/mcp.js'],
    env: { REDMINE_URL: 'https://redmine.example.test', REDMINE_API_KEY: key }, stderr: 'pipe' });
  const client = new Client({ name: 'stdio-test', version: '1' });
  await client.connect(transport); t.after(() => client.close());
  assert.equal((await client.listTools()).tools.length, 8);
});

test('CLI schema and missing config: JSON output, nonzero error, no secret echo', async () => {
  const { stdout } = await run(process.execPath, ['src/cli.js', 'schema']);
  assert.ok(JSON.parse(stdout).redmine_list_issues);
  await assert.rejects(run(process.execPath, ['src/cli.js', 'me'], { env: { ...process.env, REDMINE_URL: 'https://example.test', REDMINE_API_KEY: '', REDMINE_API_KEY_FILE: '' } }), error => {
    assert.equal(error.code, 1); assert.equal(error.stdout, ''); assert.equal(JSON.parse(error.stderr).error.code, 'CONFIG'); return true;
  });
});

test('HTTP adapter requires independent token, rejects browser origins, calls shared service', async t => {
  const { service } = await fixture(t); const token = 'independent-local-http-token-123456789';
  const server = createHttpServer(service, token); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/v1/tools`)).status, 401);
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  assert.equal((await fetch(`${base}/v1/tools`, { headers: { ...headers, Origin: 'https://evil.test' } })).status, 403);
  const result = await fetch(`${base}/v1/tools/redmine_list_issues`, { method: 'POST', headers, body: '{}' });
  assert.equal(result.status, 200); assert.ok((await result.json()).total > 0);
  const invalid = await fetch(`${base}/v1/tools/redmine_get_issue`, { method: 'POST', headers, body: '{}' });
  assert.equal(invalid.status, 400);
  const oversized = await fetch(`${base}/v1/tools/redmine_me`, { method: 'POST', headers, body: JSON.stringify({ data: 'x'.repeat(70000) }) });
  assert.equal(oversized.status, 413);
});

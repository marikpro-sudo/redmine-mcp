import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { findTextile, assertMarkdown, markupPolicy } from '../src/markup-policy.js';
import { createMcpServer } from '../src/mcp-server.js';

test('findTextile detects Textile headings and header cells only', () => {
  for (const level of [1, 2, 3, 4, 5, 6]) assert.equal(findTextile(`Текст\nh${level}. Заголовок`).line, 2);
  assert.equal(findTextile('|_. A |_. B |').kind, 'table');
  assert.equal(findTextile('a\r\nh2.\tb').line, 2);
  for (const ok of ['# Заголовок', '## Раздел', '### Подраздел', '1. пункт\n- пункт', '**жирный**', '| a | b |\n|---|---|',
    'h2.без пробела', 'см. h2. внутри строки', 'th2. нет', '    h2. блок кода отступом', '```\nh2. в коде\n|_. в коде |\n```', '', undefined]) {
    assert.equal(findTextile(ok), null, ok);
  }
});

test('assertMarkdown throws TEXTILE_MARKUP with field, line and hint', () => {
  assert.throws(() => assertMarkdown({ comment: 'ok', description: 'x\nh3. Итог' }), e =>
    e.code === 'TEXTILE_MARKUP' && e.message.includes('description') && e.message.includes('строка 2') && e.message.includes('`###`'));
  assert.throws(() => assertMarkdown([['custom_fields[5]', 'a'], ['custom_fields[5]', '|_. x |']]), e => e.message.includes('custom_fields[5]'));
  assert.doesNotThrow(() => assertMarkdown({ comment: undefined, description: '## Итог' }));
});

test('Markdown rule is visible in server instructions and writing tool descriptions', async t => {
  const server = createMcpServer({ invoke: async () => ({}) });
  const client = new Client({ name: 'test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  t.after(() => client.close());
  assert.ok(client.getInstructions().includes(markupPolicy));
  const tools = Object.fromEntries((await client.listTools()).tools.map(x => [x.name, x.description]));
  for (const name of ['redmine_prepare_change', 'redmine_prepare_create_issue']) {
    assert.ok(tools[name].includes(markupPolicy), name); assert.ok(tools[name].includes('Textile is rejected'), name);
  }
  assert.match(markupPolicy, /Markdown/); assert.match(markupPolicy, /Textile/);
});

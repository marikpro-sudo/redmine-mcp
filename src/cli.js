#!/usr/bin/env node
import { createService } from './runtime.js';
import { definitions } from './service.js';
import { AccessError, safeError } from './config.js';
import { z } from 'zod';
import { readFile } from 'node:fs/promises';

const aliases = { me: 'redmine_me', catalog: 'redmine_catalog', list: 'redmine_list_issues', issue: 'redmine_get_issue', attachment: 'redmine_read_attachment', prepare: 'redmine_prepare_change', apply: 'redmine_apply_change', operation: 'redmine_get_operation' };
try {
  const [command, input = '{}', ...extra] = process.argv.slice(2);
  if (!command || command === '--help') {
    console.log('Usage: node [--env-file=.env] src/cli.js <command> [JSON or @file.json]\nCommands: me, catalog, list, issue, attachment, prepare, apply, operation, schema\nShort forms: issue 87; apply <operation-uuid>; operation <operation-uuid>\nprepare creates a local draft. apply writes the prepared changes to Redmine.\nOutput: JSON. Errors: stderr, exit code 1.');
  } else if (command === 'schema') {
    console.log(JSON.stringify(Object.fromEntries(Object.entries(definitions).map(([k, v]) => [k, { description: v.description, inputSchema: z.toJSONSchema(v.schema, { io: 'input' }) }])), null, 2));
  } else {
    if (extra.length) throw new AccessError('INVALID_ARGUMENTS', 'Expected one JSON argument.');
    let args;
    if ((command === 'issue' || command === 'redmine_get_issue') && /^[1-9]\d*$/.test(input)) {
      args = { issue_id: Number(input) };
    } else if (['apply', 'operation', 'redmine_apply_change', 'redmine_get_operation'].includes(command) && /^[0-9a-f-]{36}$/.test(input)) {
      args = { operation_id: input };
    } else {
      let source = input;
      if (input.startsWith('@')) {
        try { source = await readFile(input.slice(1), 'utf8'); }
        catch { throw new AccessError('INVALID_ARGUMENTS', 'Cannot read the specified JSON argument file.'); }
        if (Buffer.byteLength(source) > 65536) throw new AccessError('INVALID_ARGUMENTS', 'Argument file exceeds 64 KiB.');
      }
      try { args = JSON.parse(source.replace(/^\uFEFF/, '')); }
      catch { throw new AccessError('INVALID_ARGUMENTS', 'Argument must be valid JSON. To read a task without JSON, use: issue 87'); }
    }
    const result = await (await createService()).invoke(aliases[command] || command, args);
    console.log(JSON.stringify(result, null, 2));
    if ((aliases[command] || command) === 'redmine_apply_change' && result.state !== 'applied') process.exitCode = 1;
  }
} catch (error) { console.error(JSON.stringify({ error: safeError(error) })); process.exitCode = 1; }

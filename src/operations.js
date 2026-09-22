import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { AccessError } from './config.js';

export function digest(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }

// Stable across CLI/MCP/HTTP processes; key and server changes get a separate namespace.
// An exclusive permanent claim ensures at most one PUT attempt per operation ID.
export class OperationStore {
  constructor(config) {
    this.root = config.stateDir ? join(config.stateDir, digest([config.baseUrl, config.apiKey])) : null;
  }
  async init() {
    if (!this.root) throw new AccessError('CONFIG', 'A persistent state directory is required for write operations.');
    await mkdir(this.root, { recursive: true, mode: 0o700 });
  }
  path(id, suffix) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) {
      throw new AccessError('INVALID_ARGUMENTS', 'Invalid operation ID.');
    }
    return join(this.root, `${id}.${suffix}`);
  }
  async saveNew(path, data) {
    const file = await open(path, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(data)); await file.sync(); } finally { await file.close(); }
  }
  async create(record) {
    await this.init(); const id = randomUUID();
    await this.saveNew(this.path(id, 'plan.json'), { ...record, operation_id: id });
    return id;
  }
  async read(id) {
    await this.init();
    try { return JSON.parse(await readFile(this.path(id, 'plan.json'), 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') throw new AccessError('OPERATION_NOT_FOUND', 'Operation not found for this account and Redmine instance.');
      throw error;
    }
  }
  async result(id) {
    try { return JSON.parse(await readFile(this.path(id, 'result.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async claimed(id) {
    try { await readFile(this.path(id, 'claim')); return true; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }
  async claim(id) {
    try { await this.saveNew(this.path(id, 'claim'), { started_at: new Date().toISOString() }); return true; }
    catch (error) { if (error.code === 'EEXIST') return false; throw error; }
  }
  async finish(id, result) {
    const temp = this.path(id, `${randomUUID()}.tmp`);
    await this.saveNew(temp, result);
    await rename(temp, this.path(id, 'result.json'));
  }
}

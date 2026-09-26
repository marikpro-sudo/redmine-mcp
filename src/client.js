import { AccessError } from './config.js';

export class RedmineClient {
  constructor(config, fetchImpl = fetch) { this.config = config; this.fetch = fetchImpl; }

  async readBytes(url, maxBytes, accept = 'application/json') {
    const base = new URL(this.config.baseUrl);
    const target = new URL(url, base);
    if (target.origin !== base.origin || !target.pathname.startsWith(base.pathname) ||
        target.username || target.password || target.hash) {
      throw new AccessError('UNSAFE_URL', 'Attachment URL is outside the configured Redmine instance.');
    }
    let response;
    try {
      response = await this.fetch(target, { method: 'GET', redirect: 'manual',
        headers: { 'X-Redmine-API-Key': this.config.apiKey, Accept: accept },
        signal: AbortSignal.timeout(this.config.timeoutMs) });
    } catch { throw new AccessError('NETWORK', 'Cannot reach Redmine. Check network, TLS trust and REDMINE_URL.'); }
    if (!response.ok) {
      await response.body?.cancel();
      const messages = { 401: 'Invalid or missing personal API key.',
        403: 'API access denied. Check REST API setting, account and permissions.',
        404: 'Not found or not visible to this user.', 429: 'Redmine rate limit reached. Try again later.' };
      throw new AccessError(`HTTP_${response.status}`, messages[response.status] ||
        (response.status >= 300 && response.status < 400 ? 'Redirect refused; configure the final HTTPS Redmine URL.' : 'Redmine request failed.'));
    }
    if (Number(response.headers.get('content-length')) > maxBytes) {
      await response.body?.cancel();
      throw new AccessError('TOO_LARGE', 'Response exceeds the configured size limit.');
    }
    const chunks = []; let size = 0;
    try {
      for await (const chunk of response.body ?? []) {
        size += chunk.length;
        if (size > maxBytes) throw new AccessError('TOO_LARGE', 'Response exceeds the configured size limit.');
        chunks.push(chunk);
      }
    } catch (error) {
      if (error instanceof AccessError) throw error;
      throw new AccessError('NETWORK', 'Redmine response was interrupted or timed out.');
    }
    return { bytes: Buffer.concat(chunks), contentType: response.headers.get('content-type') || '' };
  }

  async get(path, params = {}) {
    const url = new URL(path, this.config.baseUrl);
    for (const [key, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(key, String(value));
    const { bytes, contentType } = await this.readBytes(url, this.config.maxJsonBytes);
    if (!contentType.includes('application/json')) throw new AccessError('BAD_RESPONSE', 'Expected JSON. Check REST API access and URL.');
    try { return JSON.parse(bytes.toString('utf8')); }
    catch { throw new AccessError('BAD_RESPONSE', 'Redmine returned invalid JSON.'); }
  }

  async updateIssue(issueId, issue) {
    if (!Number.isSafeInteger(issueId) || issueId <= 0) throw new AccessError('INVALID_ARGUMENTS', 'Invalid issue ID.');
    // No retries: a timeout or 5xx may happen after the server committed the write.
    let response;
    try {
      response = await this.fetch(new URL(`issues/${issueId}.json`, this.config.baseUrl), {
        method: 'PUT', redirect: 'manual', signal: AbortSignal.timeout(this.config.timeoutMs),
        headers: { 'X-Redmine-API-Key': this.config.apiKey, Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ issue })
      });
    } catch { throw new AccessError('WRITE_UNCERTAIN', 'Write outcome unknown. Inspect the issue and operation; do not resend.'); }
    await response.body?.cancel().catch(() => {});
    if (response.status === 204) return;
    const rejected = { 401: 'Authentication failed.', 403: 'Redmine denied this change.',
      404: 'Issue is missing or inaccessible.', 409: 'Redmine detected a concurrent edit.',
      422: 'Redmine rejected the change. Check workflow, required fields and field permissions in the issue form.',
      429: 'Redmine rate limit reached.' };
    if (rejected[response.status]) throw new AccessError(`HTTP_${response.status}`, rejected[response.status]);
    throw new AccessError('WRITE_UNCERTAIN', 'Unexpected response to write. Inspect the issue before creating another operation.');
  }

  async createIssue(issue) {
    let response;
    try {
      response = await this.fetch(new URL('issues.json', this.config.baseUrl), {
        method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(this.config.timeoutMs),
        headers: { 'X-Redmine-API-Key': this.config.apiKey, Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ issue })
      });
    } catch { throw new AccessError('WRITE_UNCERTAIN', 'Creation outcome unknown. Do not resend.'); }
    if (response.status !== 201) {
      await response.body?.cancel().catch(() => {});
      if ([401, 403, 404, 409, 422, 429].includes(response.status)) throw new AccessError(`HTTP_${response.status}`, 'Redmine rejected creation. Check permissions, required fields and workflow.');
      throw new AccessError('WRITE_UNCERTAIN', 'Unexpected creation response. Do not resend.');
    }
    try {
      if (!response.headers.get('content-type')?.includes('application/json')) throw new Error();
      const chunks = []; let size = 0;
      for await (const chunk of response.body ?? []) {
        size += chunk.length;
        if (size > this.config.maxJsonBytes) throw new Error();
        chunks.push(chunk);
      }
      const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!Number.isSafeInteger(data.issue?.id) || data.issue.id <= 0) throw new Error();
      return data.issue.id;
    } catch { await response.body?.cancel().catch(() => {}); throw new AccessError('WRITE_UNCERTAIN', 'Creation acknowledged but issue ID could not be read. Do not resend.'); }
  }

  async all(path, key, params = {}) {
    const items = []; const seen = new Set(); let offset = 0; let initialTotal;
    for (let page = 0; page < this.config.maxPages; page++) {
      const data = await this.get(path, { ...params, offset, limit: 100 });
      const rows = data[key];
      if (!Array.isArray(rows) || !Number.isInteger(data.total_count) || data.total_count < 0 || data.offset !== offset) {
        throw new AccessError('BAD_RESPONSE', 'Invalid pagination metadata from Redmine.');
      }
      if (initialTotal === undefined) initialTotal = data.total_count;
      if (initialTotal !== data.total_count) throw new AccessError('CHANGED_DURING_READ', 'Task list changed during pagination. Retry the request.');
      for (const row of rows) {
        if (!Number.isInteger(row.id) || seen.has(row.id)) throw new AccessError('CHANGED_DURING_READ', 'Duplicate or invalid item during pagination. Retry the request.');
        seen.add(row.id); items.push(row);
      }
      offset += rows.length;
      if (offset === data.total_count) return items;
      if (!rows.length || offset > data.total_count) throw new AccessError('BAD_RESPONSE', 'Incomplete pagination; no partial result returned.');
    }
    throw new AccessError('LIMIT', 'Too many results. Narrow the project or status filter; no partial result returned.');
  }
}

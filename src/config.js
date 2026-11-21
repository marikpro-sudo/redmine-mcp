import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export class AccessError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export async function loadConfig(env = process.env) {
  let apiKey = env.REDMINE_API_KEY?.trim();
  if (!apiKey && env.REDMINE_API_KEY_FILE) {
    try { apiKey = (await readFile(env.REDMINE_API_KEY_FILE, 'utf8')).trim(); }
    catch { throw new AccessError('CONFIG', 'Cannot read REDMINE_API_KEY_FILE.'); }
  }
  let url;
  try { url = new URL(env.REDMINE_URL); }
  catch { throw new AccessError('CONFIG', 'Set REDMINE_URL to the HTTPS Redmine address.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new AccessError('CONFIG', 'REDMINE_URL must be HTTPS without credentials, query or fragment.');
  }
  if (!apiKey || apiKey.includes('\n') || apiKey === 'replace-with-your-personal-key') {
    throw new AccessError('CONFIG', 'Set a personal REDMINE_API_KEY or REDMINE_API_KEY_FILE.');
  }
  const timeZone = env.REDMINE_TIME_ZONE || 'Asia/Almaty';
  try { new Intl.DateTimeFormat('en', { timeZone }).format(); }
  catch { throw new AccessError('CONFIG', 'Invalid REDMINE_TIME_ZONE.'); }
  const collaboratorFieldId = env.REDMINE_COLLABORATOR_FIELD_ID;
  if (collaboratorFieldId && !/^[1-9]\d*$/.test(collaboratorFieldId)) {
    throw new AccessError('CONFIG', 'REDMINE_COLLABORATOR_FIELD_ID must be a positive integer.');
  }
  return { baseUrl: url.href.replace(/\/+$/, '') + '/', apiKey,
    defaultProject: env.REDMINE_PROJECT || undefined, timeZone,
    stateDir: env.REDMINE_STATE_DIR ? resolve(env.REDMINE_STATE_DIR) : join(homedir(), '.redmine-access', 'operations'),
    collaboratorFieldId: collaboratorFieldId ? Number(collaboratorFieldId) : undefined,
    timeoutMs: 20000, maxPages: 100, maxJsonBytes: 16 * 1024 * 1024,
    maxAttachmentBytes: 5 * 1024 * 1024, maxUploadBytes: 20 * 1024 * 1024,
    apiKeyFile: env.REDMINE_API_KEY_FILE ? resolve(env.REDMINE_API_KEY_FILE) : undefined };
}

export function safeError(error) {
  if (error instanceof AccessError) return { code: error.code, message: error.message };
  // Network / library errors can include credentials or response bodies.
  return { code: 'INTERNAL', message: 'Operation failed. No credentials or server response body were logged.' };
}

import { loadConfig } from './config.js';
import { RedmineClient } from './client.js';
import { RedmineService } from './service.js';
export async function createService() { return new RedmineService(new RedmineClient(await loadConfig())); }

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from './mcp-server.js';
import { createService } from './runtime.js';
import { safeError } from './config.js';

try {
  const service = await createService();
  const server = createMcpServer(service);
  await server.connect(new StdioServerTransport());
} catch (error) { console.error(JSON.stringify({ error: safeError(error) })); process.exitCode = 1; }

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { sendTool } from './send.ts';
import { speakTool } from './speak.ts';
import { gmailRecentTool, gmailSearchTool, gmailGetTool } from './gmail.ts';
import { calendarListTool, calendarCreateTool, calendarRawTool } from './calendar.ts';
import { driveSearchTool, driveReadTool, driveRawTool } from './drive.ts';
import { sheetsReadTool, sheetsWriteTool, sheetsRawTool } from './sheets.ts';
import { docsReadTool, docsRawTool } from './docs.ts';
import { slidesReadTool, slidesRawTool } from './slides.ts';
import { googleAccountsTool } from './google_accounts.ts';

const tools = [
  sendTool,
  speakTool,
  googleAccountsTool,
  gmailRecentTool,
  gmailSearchTool,
  gmailGetTool,
  calendarListTool,
  calendarCreateTool,
  calendarRawTool,
  driveSearchTool,
  driveReadTool,
  driveRawTool,
  sheetsReadTool,
  sheetsWriteTool,
  sheetsRawTool,
  docsReadTool,
  docsRawTool,
  slidesReadTool,
  slidesRawTool,
];

const server = new Server(
  { name: 'nothingclaw', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map((t) => t.definition),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const tool = tools.find((t) => t.definition.name === req.params.name);
  if (!tool) {
    return {
      content: [{ type: 'text', text: `Unknown tool: ${req.params.name}` }],
      isError: true,
    };
  }
  return tool.handler(req.params.arguments ?? {});
});

await server.connect(new StdioServerTransport());
console.error('[nothingclaw-mcp] ready');

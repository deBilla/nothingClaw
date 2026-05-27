import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { sendTool } from './send.ts';
import { sendFileTool } from './send_file.ts';
import { speakTool } from './speak.ts';
import { gmailRecentTool, gmailSearchTool, gmailGetTool, gmailSendTool } from './gmail.ts';
import { contactsSearchTool } from './contacts.ts';
import { calendarListTool, calendarCreateTool, calendarRawTool } from './calendar.ts';
import { driveSearchTool, driveReadTool, driveRawTool } from './drive.ts';
import { sheetsReadTool, sheetsWriteTool, sheetsRawTool } from './sheets.ts';
import { docsReadTool, docsRawTool } from './docs.ts';
import { slidesReadTool, slidesRawTool } from './slides.ts';
import { googleAccountsTool } from './google_accounts.ts';

const tools = [
  sendTool,
  sendFileTool,
  speakTool,
  googleAccountsTool,
  gmailRecentTool,
  gmailSearchTool,
  gmailGetTool,
  gmailSendTool,
  contactsSearchTool,
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
  { name: 'marsclaw', version: '0.1.0' },
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
console.error('[marsclaw-mcp] ready');

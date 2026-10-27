import {z} from 'zod';

export const mcpTools = {
  list_connections: {
    description:'List saved GooeShell SSH connections and login identity names. Credentials remain in GooeShell.',
    schema:z.strictObject({}), readOnly:true,
  },
  list_sessions: {
    description:'List live SSH sessions. source=terminal belongs to the user; source=mcp is a background bridge connection.',
    schema:z.strictObject({}), readOnly:true,
  },
  connect: {
    description:'Reuse an existing SSH session or connect a saved connection using its GooeShell credentials and jump host. Missing credentials and host key confirmation must be handled in GooeShell; do not request passwords through this tool.',
    schema:z.strictObject({connectionId:z.string().min(1).max(255)}), readOnly:false,
  },
  run_command: {
    description:'Run a command through an existing SSH connection, on an independent channel. Each call has a fresh /bin/sh; use cwd for its working directory. sudo=true uses the password managed by GooeShell. Long-running work belongs in tmux: create detached sessions/windows, split-window -d -P -F "#{pane_id}", then use explicit pane IDs with send-keys and capture-pane -p. Do not assume the user\'s active pane. Disconnecting MCP does not stop detached tmux jobs. This tool returns command output and exit status, not the result of an asynchronously launched tmux job.',
    schema:z.strictObject({sessionId:z.string().min(1).max(255),command:z.string().min(1).max(65536),cwd:z.string().max(2048).startsWith('/').optional(),sudo:z.boolean().default(false),timeoutMs:z.number().int().min(100).max(60000).default(30000)}), readOnly:false,
  },
};
export type McpToolName = keyof typeof mcpTools;
export function parseMcpCall(name:unknown,args:unknown):{name:McpToolName;args:any} {
  if(typeof name!=='string'||!Object.hasOwn(mcpTools,name))throw new Error('不支持的 MCP 操作');
  const tool=name as McpToolName;
  return{name:tool,args:mcpTools[tool].schema.parse(args)};
}

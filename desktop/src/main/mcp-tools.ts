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
    description:'Run a short command through an existing SSH connection on an independent channel. Each call has a fresh /bin/sh; use cwd for its working directory. sudo=true privately uses GooeShell credentials. Returns the actual command stdout, stderr and exit status. For background or longer work use start_task/read_task; do not infer task completion from tmux send-keys returning successfully. Never type credentials into terminal panes.',
    schema:z.strictObject({sessionId:z.string().min(1).max(255),command:z.string().min(1).max(65536),cwd:z.string().max(2048).startsWith('/').optional(),sudo:z.boolean().default(false),timeoutMs:z.number().int().min(100).max(60000).default(30000)}), readOnly:false,
  },
  start_task: {
    description:'Start a background command in a new managed tmux window, visible to the user in session gooeshell-ai. Requires tmux on the server. sudo=true privately supplies GooeShell credentials through a one-time owner-only pipe, never pane keystrokes, command arguments or files containing the password. Returns taskId and observed state; use read_task for completion and the actual exit code. Closing MCP or SSH does not stop an already launched task. On a start timeout, inspect gooeshell-ai before retrying: execution may already have started.',
    schema:z.strictObject({sessionId:z.string().min(1).max(255),command:z.string().min(1).max(65536),cwd:z.string().max(2048).startsWith('/').optional(),sudo:z.boolean().default(false)}),readOnly:false,
  },
  read_task: {
    description:'Read a managed background task by taskId on the same server/login. Returns running/finishing/exited, actual exitCode or signal when available, and recent merged terminal output. finishing means terminal EOF arrived before process exit status; check again later. A non-exited task or null exit code is not success. Output is tmux scrollback, not a complete durable log. If the user removed its pane or tmux server restarted, completion cannot be recovered. Do not poll continuously; wait between checks or do other work.',
    schema:z.strictObject({sessionId:z.string().min(1).max(255),taskId:z.string().uuid(),tailLines:z.number().int().min(1).max(1000).default(200)}),readOnly:true,
  },
};
export type McpToolName = keyof typeof mcpTools;
export function parseMcpCall(name:unknown,args:unknown):{name:McpToolName;args:any} {
  if(typeof name!=='string'||!Object.hasOwn(mcpTools,name))throw new Error('不支持的 MCP 操作');
  const tool=name as McpToolName;
  return{name:tool,args:mcpTools[tool].schema.parse(args)};
}

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
  stop_task: {
    description:'Stop only a GooeShell-managed tmux task by its taskId. Sends TERM to its dedicated process group and waits for the actual completion status. Does not kill unrelated panes or the tmux server. Older tasks without managed cancellation must be stopped manually.',
    schema:z.strictObject({sessionId:z.string().min(1).max(255),taskId:z.string().uuid()}),readOnly:false,
  },
  read_log: {
    description:'Read a bounded UTF-8 log chunk from an absolute regular file path. Continue with nextOffset and cursor; rotated/truncated files reset to offset 0 and report reset=true. This reads a file, not tmux scrollback. Poll no faster than once per second. Does not use sudo.',
    schema:z.strictObject({sessionId:z.string().min(1).max(255),path:z.string().min(1).max(2048).startsWith('/'),offset:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),cursor:z.string().max(128).optional(),maxBytes:z.number().int().min(1).max(16384).default(16384)}),readOnly:true,
  },
  transfer_file: {
    description:'Start a local upload/download using GooeShell SFTP with resumable content verification. Absolute source/destinationDir paths, no sudo. Returns transferId; use read_transfer/stop_transfer. This operation transfers data through this computer.',
    schema:z.strictObject({sessionId:z.string().min(1).max(255),direction:z.enum(['upload','download']),source:z.string().min(1).max(2048),destinationDir:z.string().min(1).max(2048),resume:z.boolean().default(true),mode:z.enum(['direct','archive']).default('direct')}),readOnly:false,
  },
  transfer_between_servers: {
    description:'Start server-to-server transfer without routing file payload through this computer. Requires two live Linux SSH sessions, Python 3, rsync, rrsync and OpenSSH tools. auto tries push then reverse pull reachability; pull means target initiates SSH to source. Installs a task-limited, expiring SSH public key and revokes it afterwards. Preserves remote partials, verifies full SHA-256 and never overwrites an existing final destination. Returns transferId; read_transfer reports progress/route/speed; stop_transfer cancels.',
    schema:z.strictObject({sessionId:z.string().min(1).max(255),targetSessionId:z.string().min(1).max(255),source:z.string().max(2048).startsWith('/'),destinationDir:z.string().max(2048).startsWith('/'),route:z.enum(['auto','push','pull']).default('auto')}),readOnly:false,
  },
  read_transfer: {
    description:'Read transfer state, byte progress, bytesPerSecond and verification stage. Estimate remaining transfer seconds as (total-done)/bytesPerSecond when positive; verification takes additional time. Recent 200 tasks are kept while GooeShell is running.',
    schema:z.strictObject({transferId:z.string().uuid()}),readOnly:true,
  },
  stop_transfer: {
    description:'Cancel a transfer by transferId. Remote partials are retained for verification/resume. Check read_transfer until cancelled/failed/completed; requesting cancellation alone does not prove that cleanup has finished.',
    schema:z.strictObject({transferId:z.string().uuid()}),readOnly:false,
  },
};
export type McpToolName = keyof typeof mcpTools;
export function parseMcpCall(name:unknown,args:unknown):{name:McpToolName;args:any} {
  if(typeof name!=='string'||!Object.hasOwn(mcpTools,name))throw new Error('不支持的 MCP 操作');
  const tool=name as McpToolName;
  return{name:tool,args:mcpTools[tool].schema.parse(args)};
}

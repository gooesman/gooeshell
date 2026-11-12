import {z} from 'zod';

const connectionText=z.string().trim().min(1).max(255).regex(/^[^\x00-\x1f\x7f]+$/);
const connectionEndpoint=z.strictObject({
  host:connectionText,port:z.number().int().min(1).max(65535).default(22),username:connectionText.optional(),
  auth:z.enum(['password','key','agent']).default('password'),privateKeyPath:z.string().trim().min(1).max(2048).regex(/^[^\x00-\x1f\x7f]+$/).optional(),
  loginIdentityId:connectionText.optional(),rememberHost:z.boolean().default(true),
});

export const mcpTools = {
  list_connections: {
    description:'List saved GooeShell SSH connections and login identity names. Credentials remain in GooeShell.',
    schema:z.strictObject({}), readOnly:true,
  },
  list_sessions: {
    description:'List live SSH sessions. source=terminal belongs to the user; source=mcp is a background bridge connection.',
    schema:z.strictObject({}), readOnly:true,
  },
  list_connection_options: {
    description:'List saved connection groups and shared login identities (ID, name, username and whether a password is saved). No passwords or private keys are returned.',
    schema:z.strictObject({}),readOnly:true,
  },
  create_connection: {
    description:'Save a new SSH connection to GooeShell without connecting. It is not added to the sidebar unless the user explicitly requests it (favorite=true). Uses an existing shared login identity or a username and password/key/agent authentication. Never accepts passwords, passphrases or private key contents. Optional jumpHost uses the same rules. Call list_connection_options for identity and group IDs. Equivalent existing configurations are returned unchanged with created=false. Connection and host-key verification happen separately.',
    schema:connectionEndpoint.extend({name:connectionText.optional(),groupId:connectionText.optional(),icon:z.enum(['server','cloud','database','router','code','folder']).optional(),encoding:z.enum(['utf8','gb18030','big5']).default('utf8'),favorite:z.boolean().default(false),shellIntegration:z.boolean().default(false),jumpHost:connectionEndpoint.extend({name:connectionText.optional(),reuseConnection:z.boolean().default(true)}).optional()}),readOnly:false,
  },
  connect: {
    description:'Reuse an existing SSH session or connect a saved connection using its GooeShell credentials and jump host. hostKeyPolicy defaults to once: automatically accept without verifying or saving the server and jump host fingerprints. Use save only when the user explicitly requests persistent trust; this accepts and saves the presented fingerprints, replacing previous values. Missing credentials must be handled in GooeShell; never ask for passwords through this tool.',
    schema:z.strictObject({connectionId:z.string().min(1).max(255),hostKeyPolicy:z.enum(['once','save']).default('once')}), readOnly:false,
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
  read_remote_text: {
    description:'Read a remote regular text file using the existing SSH/SFTP connection. Returns text, revision, encoding, BOM and line-ending metadata. Files larger than 2 MiB are previews and cannot be saved. Keep the revision and encoding for a subsequent edit. Does not use sudo.',
    schema:z.strictObject({sessionId:z.string().min(1).max(255),path:z.string().min(1).max(2048).startsWith('/'),encoding:z.enum(['utf8','utf8-bom','utf16le','utf16be','gb18030','big5']).optional()}),readOnly:true,
  },
  write_remote_text: {
    description:'Create or replace a remote regular text file using SSH/SFTP. For creation use expectedRevision="missing"; for replacement first read the file and provide its revision, encoding and BOM. A changed file is rejected. The entire MCP request is limited to 256 KiB. Does not use sudo.',
    schema:z.strictObject({sessionId:z.string().min(1).max(255),path:z.string().min(1).max(2048).startsWith('/'),text:z.string().max(2*1024*1024),encoding:z.enum(['utf8','utf8-bom','utf16le','utf16be','gb18030','big5']),bom:z.boolean().optional(),expectedRevision:z.union([z.literal('missing'),z.string().regex(/^v1:[a-f0-9]{64}$/)])}),readOnly:false,
  },
  edit_remote_text: {
    description:'Replace exactly one occurrence in an existing remote text file, preserving its detected encoding, BOM and other content. First read the file and supply its revision. Missing or repeated matches and changed files are rejected. Optional encoding is needed for non-UTF-8 files without a BOM. Does not use sudo.',
    schema:z.strictObject({sessionId:z.string().min(1).max(255),path:z.string().min(1).max(2048).startsWith('/'),expectedRevision:z.string().regex(/^v1:[a-f0-9]{64}$/),oldText:z.string().min(1).max(131072),newText:z.string().max(131072),encoding:z.enum(['utf8','utf8-bom','utf16le','utf16be','gb18030','big5']).optional()}),readOnly:false,
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
  show_in_app: {
    description:'Show AI command activity, a managed tmux task, a remote log or a transfer in the GooeShell window. Task and log views refresh while open; transfer opens the existing queue. This does not type into or alter the user terminal. Showing a view is not proof that a task succeeded.',
    schema:z.discriminatedUnion('kind',[
      z.strictObject({kind:z.literal('activity')}),
      z.strictObject({kind:z.literal('task'),sessionId:z.string().min(1).max(255),taskId:z.string().uuid()}),
      z.strictObject({kind:z.literal('log'),sessionId:z.string().min(1).max(255),path:z.string().min(1).max(2048).startsWith('/')}),
      z.strictObject({kind:z.literal('transfer'),transferId:z.string().uuid()}),
    ]),readOnly:false,
  },
};
export type McpToolName = keyof typeof mcpTools;
export function parseMcpCall(name:unknown,args:unknown):{name:McpToolName;args:any} {
  if(typeof name!=='string'||!Object.hasOwn(mcpTools,name))throw new Error('不支持的 MCP 操作');
  const tool=name as McpToolName;
  return{name:tool,args:mcpTools[tool].schema.parse(args)};
}

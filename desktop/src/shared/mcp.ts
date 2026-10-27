export interface McpStatus {
  available: boolean;
  enabled: boolean;
  config?: {command: string; args: string[]; env: Record<string,string>};
}
export interface BridgeCommand {
  sessionId: string; command: string; cwd?: string; sudo: boolean; timeoutMs: number;
}
export interface BridgeCommandResult {
  stdout: string; stderr: string; exitCode: number | null; signal: string | null; truncated: boolean;
}

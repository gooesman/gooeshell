export interface McpStatus {
  available: boolean;
  enabled: boolean;
  cliPath?: string;
  config?: {command: string; args: string[]; env: Record<string,string>};
}
export interface BridgeCommand {
  sessionId: string; command: string; cwd?: string; sudo: boolean; timeoutMs: number;
}
export interface BridgeCommandResult {
  stdout: string; stderr: string; exitCode: number | null; signal: string | null; truncated: boolean;
}
export interface BridgeTaskStart {sessionId:string;command:string;cwd?:string;sudo:boolean;}
export interface BridgeTaskRead {sessionId:string;taskId:string;tailLines:number;}
export interface BridgeLogRead {sessionId:string;path:string;offset:number;cursor?:string;maxBytes:number;}
export interface BridgeTaskResult {taskId:string;sessionName:string;windowId:string;paneId:string;state:'running'|'finishing'|'exited';exitCode:number|null;signal:string|null;output?:string;truncated?:boolean;}

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
export interface BridgeTaskResult {taskId:string;sessionName:string;windowId:string;paneId:string;backend?:'tmux'|'process';state:'running'|'finishing'|'exited'|'unknown';exitCode:number|null;signal:string|null;output?:string;truncated?:boolean;logPath?:string;}
export type AiView = {kind:'activity'} | {kind:'task';sessionId:string;taskId:string} | {kind:'log';sessionId:string;path:string} | {kind:'transfer';transferId:string};
export interface AiActivity {id:string;sessionId:string;connectionName:string;kind:'command'|'task';command:string;cwd?:string;sudo:boolean;state:'running'|'finished'|'failed';output?:string;taskId?:string;exitCode?:number|null;truncated?:boolean;}

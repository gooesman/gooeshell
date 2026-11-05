import type { EditableTextFile } from '../shared/types';

/** Use the same revision-checked SFTP editor as the desktop UI. */
export async function bridgeRemoteText(name: 'read_remote_text'|'write_remote_text'|'edit_remote_text', args: any,
  signal: AbortSignal, remote: (method: string, request: any) => Promise<any>, sessionCurrent: () => boolean): Promise<unknown> {
  signal.throwIfAborted();
  if (name === 'read_remote_text') return remote('readTextFile', args);
  if (name === 'write_remote_text') return remote('writeTextFile', args);
  const snapshot = await remote('readTextFile', { sessionId: args.sessionId, path: args.path, encoding: args.encoding }) as EditableTextFile;
  signal.throwIfAborted();
  if (!sessionCurrent()) throw new Error('SSH 会话已断开，请重新连接');
  if (snapshot.truncated || snapshot.revision !== args.expectedRevision) throw new Error('TEXT_CONFLICT：文件自读取后已更改，或文件过大；请重新读取。');
  const at = snapshot.text.indexOf(args.oldText);
  if (at < 0 || at !== snapshot.text.lastIndexOf(args.oldText)) throw new Error('TEXT_MATCH_ERROR：原文必须恰好出现一次，文件未修改。');
  const text = snapshot.text.slice(0, at) + args.newText + snapshot.text.slice(at + args.oldText.length);
  return remote('writeTextFile', { sessionId: args.sessionId, path: args.path, text, encoding: snapshot.encoding, bom: snapshot.bom, expectedRevision: snapshot.revision });
}

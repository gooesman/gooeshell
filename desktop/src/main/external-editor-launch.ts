import path from 'node:path';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import type { AppSettings } from '../shared/types';

export function externalEditorForFile(settings: Pick<AppSettings, 'externalEditorPath' | 'externalEditorByExtension'>, file: string): string {
  return settings.externalEditorByExtension?.[path.extname(file).toLowerCase()] ?? settings.externalEditorPath;
}

// Never let a script's system association execute it as an "editor".
const documentExtensions = new Set(['.txt', '.md', '.markdown', '.mdown', '.rst', '.log', '.json', '.yaml', '.yml', '.toml', '.ini', '.conf', '.cfg', '.csv', '.tsv', '.xml']);
export function externalEditorCommand(editor: string, file: string, platform = process.platform): { command: string; args: string[] } | null {
  if (!path.isAbsolute(file) || file.includes('\0')) throw new Error('文件路径无效');
  if (!editor) {
    if (!documentExtensions.has(path.extname(file).toLowerCase())) throw new Error('此文件类型可能被系统直接执行，请在设置 → 外部编辑器中为此扩展名指定文本编辑器，其他文件仍可使用各自的系统默认应用。');
    return null;
  }
  if (!path.isAbsolute(editor) || /[\0\r\n]/.test(editor)) throw new Error('请选择编辑器的完整程序路径，不填写命令或参数');
  if (platform === 'win32' && path.extname(editor).toLowerCase() !== '.exe') throw new Error('请选择编辑器的 .exe 程序');
  if (platform === 'darwin' && editor.endsWith('.app')) return { command: '/usr/bin/open', args: ['-a', editor, file] };
  return { command: editor, args: [file] };
}
export async function launchExternalEditor(editor: string, file: string, openPath: (file: string) => Promise<string>): Promise<void> {
  const command = externalEditorCommand(editor, file);
  if (!command) { const error = await openPath(file); if (error) throw new Error('无法打开系统默认应用，请在设置中指定编辑器。' + error); return; }
  const info = await fs.stat(editor);
  if (!(process.platform === 'darwin' && editor.endsWith('.app') ? info.isDirectory() : info.isFile())) throw new Error('编辑器程序不存在');
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command.command, command.args, { shell: false, detached: true, stdio: 'ignore', windowsHide: false });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

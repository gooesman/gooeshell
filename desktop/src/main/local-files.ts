import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { TextFile } from '../shared/types';

const MAX_TEXT = 2 * 1024 * 1024;

function localPath(value: string): string {
  if (typeof value !== 'string' || !value || value.includes('\0')) throw new Error('文件路径无效');
  return path.resolve(value);
}

export async function readLocalText(file: string): Promise<TextFile> {
  const handle = await fs.open(localPath(file), 'r');
  try {
    if (!(await handle.stat()).isFile()) throw new Error('请选择普通文件');
    // Read one extra byte to detect truncation, and honor short reads rather than
    // interpreting the unused part of an allocation as file contents.
    const buffer = Buffer.alloc(MAX_TEXT + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const truncated = length > MAX_TEXT;
    const data = buffer.subarray(0, Math.min(length, MAX_TEXT));
    if (data.includes(0)) throw new Error('该文件包含二进制内容，请用对应程序打开');
    try {
      // A preview can end in the middle of a UTF-8 sequence. Keep that incomplete
      // suffix buffered; the editor already prevents saving truncated previews.
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data, { stream: truncated });
      return { text, truncated };
    } catch {
      throw new Error('该文件不是 UTF-8 编码，不能在当前文本编辑器中保存；请使用支持其原编码的程序打开');
    }
  } finally {
    await handle.close();
  }
}

export async function renameLocalPath(source: string, destination: string): Promise<void> {
  const from = localPath(source);
  const to = localPath(destination);
  if (from === to) return;
  try {
    await fs.lstat(to);
    throw new Error('目标名称已存在，请使用其他名称；未覆盖已有文件');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await fs.rename(from, to);
}

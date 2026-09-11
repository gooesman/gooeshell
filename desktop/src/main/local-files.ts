import { promises as fs } from 'node:fs';
import type { Stats } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { EditableTextFile, EditorEncoding, TextFile, TextWriteResult } from '../shared/types';
import { decodeEditableText, encodeEditableText, MAX_EDITABLE_TEXT, serializeTextWrite, textConflict, textRevision, validateExpectedRevision } from './text-files';

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

function localMetadata(info: Stats): number[] {
  return [info.size, info.mtimeMs, info.mode, info.uid, info.gid, info.dev, info.ino];
}
function sameLocalFile(a: Stats, b: Stats): boolean {
  return JSON.stringify(localMetadata(a)) === JSON.stringify(localMetadata(b)) && a.ctimeMs === b.ctimeMs;
}

async function localSnapshot(target: string): Promise<{ data: Buffer; info: Stats; truncated: boolean; revision: string }> {
  const initial = await fs.lstat(target);
  if (!initial.isFile()) throw new Error('文本编辑仅支持普通文件，请先打开符号链接的实际目标');
  const handle = await fs.open(target, 'r');
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !sameLocalFile(initial, opened)) throw textConflict();
    const buffer = Buffer.alloc(Math.min(opened.size, MAX_EDITABLE_TEXT) + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const after = await handle.stat();
    const current = await fs.lstat(target);
    if (!sameLocalFile(opened, after) || !current.isFile() || !sameLocalFile(after, current)) throw textConflict();
    const truncated = length > MAX_EDITABLE_TEXT || after.size > MAX_EDITABLE_TEXT;
    const data = buffer.subarray(0, Math.min(length, MAX_EDITABLE_TEXT));
    return { data, info: after, truncated, revision: textRevision(data, localMetadata(after), truncated) };
  } finally { await handle.close(); }
}

export async function readLocalTextFile(request: { path: string; encoding?: EditorEncoding }): Promise<EditableTextFile> {
  const snapshot = await localSnapshot(localPath(request.path));
  return decodeEditableText(snapshot.data, { encoding: request.encoding, truncated: snapshot.truncated, revision: snapshot.revision, size: snapshot.info.size });
}

/** Used only after an explicit save-dialog overwrite choice; the old file's encoding may differ. */
export async function readLocalTextRevision(file: string): Promise<string> {
  return (await localSnapshot(localPath(file))).revision;
}

export async function writeLocalTextFile(request: {
  path: string; text: string; encoding: EditorEncoding; expectedRevision: string; bom?: boolean;
}): Promise<TextWriteResult> {
  const target = localPath(request.path);
  validateExpectedRevision(request.expectedRevision);
  const data = encodeEditableText(request.text, request.encoding, request.bom);
  return serializeTextWrite(`local:${process.platform === 'win32' ? target.toLowerCase() : target}`, async () => {
    const baseline = async () => {
      try {
        const snapshot = await localSnapshot(target);
        if (snapshot.revision !== request.expectedRevision) throw textConflict();
        return snapshot;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          if (request.expectedRevision === 'missing') return undefined;
          throw textConflict();
        }
        throw error;
      }
    };
    const previous = await baseline();
    const temporary = path.join(path.dirname(target), `.gooeshell-edit-${randomUUID()}`);
    let created = false;
    try {
      const handle = await fs.open(temporary, 'wx', 0o600);
      created = true;
      let written: Stats;
      try {
        await handle.writeFile(data);
        if (previous) {
          const attrs = await handle.stat();
          if (process.platform !== 'win32' && (attrs.uid !== previous.info.uid || attrs.gid !== previous.info.gid)) {
            await handle.chown(previous.info.uid, previous.info.gid);
          }
          await handle.chmod(previous.info.mode & 0o7777);
        }
        await handle.sync();
        written = await handle.stat();
      } finally { await handle.close(); }
      await baseline();
      if (previous) await fs.rename(temporary, target);
      else {
        // A hard-link create is atomic and fails if another application creates the destination.
        try { await fs.link(temporary, target); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw textConflict(); throw error; }
        await fs.unlink(temporary);
      }
      created = false;
      return { revision: textRevision(data, localMetadata(written)), size: data.length };
    } finally { if (created) await fs.unlink(temporary).catch(() => {}); }
  });
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

import { promises as fs } from 'node:fs';
import path from 'node:path';

/** Explorer mutations always name an absolute entry, never a working directory. */
export function remoteMutationPath(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.includes('\0')) throw new Error('请使用完整的绝对文件路径');
  if (value.split('/').some(part => part === '.' || part === '..')) throw new Error('不能操作包含 . 或 .. 的路径');
  const result = path.posix.normalize(value).replace(/\/+$/, '');
  if (!result) throw new Error('不能操作文件系统根目录');
  return result;
}

export function localMutationPath(value: unknown): string {
  if (typeof value !== 'string' || !value || value.includes('\0') || !path.isAbsolute(value)) throw new Error('请使用完整的绝对文件路径');
  if (value.split(process.platform === 'win32' ? /[\\/]/ : /\//).some(part => part === '.' || part === '..')) throw new Error('不能操作包含 . 或 .. 的路径');
  if (process.platform === 'win32' && (/^\\\\[?.]\\/.test(value) || value.slice(path.parse(value).root.length).includes(':'))) throw new Error('不支持设备路径或文件流路径');
  const result = path.resolve(value);
  if (result === path.parse(result).root) throw new Error('不能操作文件系统根目录');
  return result;
}

function creationError(error: unknown): never {
  if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('此名称已存在，请使用其他名称；未覆盖已有内容');
  throw error;
}

export async function createLocalFile(file: string): Promise<void> {
  const target = localMutationPath(file);
  try {
    const handle = await fs.open(target, 'wx', 0o644);
    await handle.close();
  } catch (error) { creationError(error); }
}

export async function createLocalDirectory(directory: string): Promise<void> {
  try { await fs.mkdir(localMutationPath(directory), { mode: 0o755 }); }
  catch (error) { creationError(error); }
}

export async function removeLocalFile(file: string, recursive: boolean): Promise<void> {
  if (typeof recursive !== 'boolean') throw new Error('必须明确是否删除目录及其中的全部内容');
  const target = localMutationPath(file);
  // Reject linked ancestors; a selected link itself is only unlinked. In particular,
  // Windows junctions must not silently turn a local delete into a different tree.
  const ancestors: { name: string; dev: number; ino: number }[] = [];
  for (let parent = path.dirname(target); parent !== path.dirname(parent); parent = path.dirname(parent)) {
    const info = await fs.lstat(parent);
    if (info.isSymbolicLink()) throw new Error('上级目录是符号链接，请先进入实际路径再删除');
    ancestors.push({ name: parent, dev: info.dev, ino: info.ino });
  }
  const before = await fs.lstat(target);
  for (const parent of ancestors) {
    const current = await fs.lstat(parent.name);
    if (current.isSymbolicLink() || current.dev !== parent.dev || current.ino !== parent.ino) throw new Error('删除前上级目录发生变化，请刷新后重试');
  }
  const current = await fs.lstat(target);
  if (before.dev !== current.dev || before.ino !== current.ino || before.mode !== current.mode) throw new Error('删除前目标发生变化，请刷新后重试');
  if (current.isSymbolicLink() || !current.isDirectory()) await fs.unlink(target);
  else if (recursive) await fs.rm(target, { recursive: true, force: false });
  else await fs.rmdir(target);
}

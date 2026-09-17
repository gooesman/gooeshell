import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { utils } from 'ssh2';

const run = promisify(execFile);
const MAX_KEY = 1024 * 1024;
export interface PreparedLocalKey { keyId: string; publicKey: string; fingerprint: string; privateKeyPath?: string; name: string }
export interface ResolvedLocalKey { publicKey: string; privateKeyPath?: string; passphrase?: string }
type KeyGenerator = (options: utils.KeyPairOptions) => Promise<utils.KeyPairReturn>;
const generatePair: KeyGenerator = options => new Promise((resolve, reject) => utils.generateKeyPair('ed25519', options,
  (error, pair) => error ? reject(error) : resolve(pair)));

/** ssh2 1.17 may truncate an Ed25519 leading zero. Never write an invalid generated key pair. */
export async function generateVerifiedEd25519KeyPair(passphrase?: string, generate: KeyGenerator = generatePair): Promise<utils.KeyPairReturn> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const pair = await generate({ comment: 'gooeshell', ...(passphrase ? { passphrase, cipher: 'aes256-ctr', rounds: 64 } : {}) });
    const privateKey = utils.parseKey(pair.private, passphrase), publicKey = utils.parseKey(pair.public);
    if (privateKey instanceof Error || publicKey instanceof Error || Array.isArray(privateKey) || Array.isArray(publicKey)) continue;
    if (privateKey.type !== 'ssh-ed25519' || publicKey.type !== 'ssh-ed25519' || !privateKey.isPrivateKey() || publicKey.isPrivateKey()) continue;
    if (!privateKey.getPublicSSH().equals(publicKey.getPublicSSH())) continue;
    const challenge = Buffer.from('gooeshell generated key validation');
    try { if (!publicKey.verify(challenge, privateKey.sign(challenge))) continue; } catch { continue; }
    return pair;
  }
  throw new Error('未能生成有效的 Ed25519 密钥，未写入任何密钥文件，请重试');
}
function secret(value?: string): string | undefined {
  if (value !== undefined && (typeof value !== 'string' || value.length > 65536 || value.includes('\0'))) throw new Error('私钥口令无效');
  return value || undefined;
}
export function canonicalPublicKey(source: string | Buffer, passphrase?: string): { publicKey: string; fingerprint: string; isPrivate: boolean } {
  const parsed = utils.parseKey(source, passphrase);
  if (parsed instanceof Error || Array.isArray(parsed)) throw new Error('无法读取 SSH 密钥，请检查文件格式和私钥口令');
  const bytes = parsed.getPublicSSH();
  return { publicKey: `${parsed.type} ${bytes.toString('base64')}`, fingerprint: `SHA256:${createHash('sha256').update(bytes).digest('base64').replace(/=+$/, '')}`, isPrivate: parsed.isPrivateKey() };
}

/** Opaque, short-lived handles keep passphrases and private-key contents out of renderer state. */
export class LocalKeyStore {
  private readonly keys = new Map<string, { key: ResolvedLocalKey; expires: number }>();
  constructor(private readonly directory: string) {}
  private remember(name: string, parsed: ReturnType<typeof canonicalPublicKey>, privateKeyPath?: string, passphrase?: string): PreparedLocalKey {
    for (const [id, item] of this.keys) if (item.expires <= Date.now()) this.keys.delete(id);
    if (this.keys.size >= 100) this.keys.delete(this.keys.keys().next().value!);
    const keyId = randomUUID();
    this.keys.set(keyId, { key: { publicKey: parsed.publicKey, privateKeyPath, passphrase }, expires: Date.now() + 30 * 60_000 });
    return { keyId, publicKey: parsed.publicKey, fingerprint: parsed.fingerprint, privateKeyPath, name };
  }
  async prepare(request: { path: string; passphrase?: string }): Promise<PreparedLocalKey> {
    if (typeof request.path !== 'string' || !path.isAbsolute(request.path) || request.path.includes('\0')) throw new Error('请选择本机的 SSH 密钥文件');
    const passphrase = secret(request.passphrase);
    const file = await fs.open(request.path, 'r');
    let bytes: Buffer | undefined;
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > MAX_KEY) throw new Error('密钥必须是小于 1 MiB 的普通文件');
      bytes = Buffer.alloc(MAX_KEY + 1);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      if (bytesRead > MAX_KEY) throw new Error('密钥文件过大');
      const parsed = canonicalPublicKey(bytes.subarray(0, bytesRead), passphrase);
      return this.remember(path.basename(request.path), parsed, parsed.isPrivate ? request.path : undefined, parsed.isPrivate ? passphrase : undefined);
    } finally { bytes?.fill(0); await file.close(); }
  }
  async generate(request: { name: string; passphrase?: string }): Promise<PreparedLocalKey> {
    const name = typeof request.name === 'string' ? request.name.trim() : '';
    if (!name || name.length > 120 || /[\x00-\x1f]/.test(name)) throw new Error('请输入 1 至 120 个字符的密钥名称');
    const passphrase = secret(request.passphrase);
    const pair = await generateVerifiedEd25519KeyPair(passphrase);
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (!(await fs.lstat(this.directory)).isDirectory()) throw new Error('密钥目录不能是符号链接');
    const generated = path.join(this.directory, `ed25519-${randomUUID()}`);
    await fs.mkdir(generated, { mode: 0o700 });
    // Windows mode bits do not restrict ACLs. Set this new, private directory before writing secrets.
    if (process.platform === 'win32') {
      const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value'], { windowsHide: true });
      const sid = stdout.trim();
      if (!/^S-1-(?:\d+-)*\d+$/.test(sid)) throw new Error('无法确认当前 Windows 用户，未写入私钥');
      await run('icacls.exe', [generated, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F'], { windowsHide: true });
    }
    const privateKeyPath = path.join(generated, 'id_ed25519');
    await fs.writeFile(privateKeyPath, pair.private, { mode: 0o600, flag: 'wx' });
    await fs.writeFile(`${privateKeyPath}.pub`, `${pair.public}\n`, { mode: 0o644, flag: 'wx' });
    return this.remember(name, canonicalPublicKey(pair.public), privateKeyPath, passphrase);
  }
  resolve(keyId: string): ResolvedLocalKey {
    const item = this.keys.get(keyId);
    if (!item || item.expires <= Date.now()) { this.keys.delete(keyId); throw new Error('所选密钥已过期，请重新选择'); }
    return { ...item.key };
  }
  clear(): void { this.keys.clear(); }
}

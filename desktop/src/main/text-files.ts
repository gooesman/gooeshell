import { createHash } from 'node:crypto';
import iconv from 'iconv-lite';
import type { EditableTextFile, EditorEncoding, EditorLineEnding } from '../shared/types';

export const MAX_EDITABLE_TEXT = 2 * 1024 * 1024;
const encodings: readonly EditorEncoding[] = ['utf8', 'utf8-bom', 'utf16le', 'utf16be', 'gb18030', 'big5'];
const utf8Bom = Buffer.from([0xef, 0xbb, 0xbf]);
const littleBom = Buffer.from([0xff, 0xfe]);
const bigBom = Buffer.from([0xfe, 0xff]);

export function validateEncoding(value: unknown): asserts value is EditorEncoding {
  if (!encodings.includes(value as EditorEncoding)) throw new Error('不支持此文本编码');
}

export function detectLineEnding(text: string): EditorLineEnding {
  const crlf = text.includes('\r\n');
  const remainder = text.replaceAll('\r\n', '');
  const lf = remainder.includes('\n');
  const cr = remainder.includes('\r');
  return Number(crlf) + Number(lf) + Number(cr) > 1 ? 'mixed' : crlf ? 'crlf' : lf ? 'lf' : cr ? 'cr' : 'none';
}

function bomEncoding(data: Buffer): EditorEncoding | undefined {
  if (data.subarray(0, 3).equals(utf8Bom)) return 'utf8-bom';
  if (data.subarray(0, 2).equals(littleBom)) return 'utf16le';
  if (data.subarray(0, 2).equals(bigBom)) return 'utf16be';
  return undefined;
}

/** Metadata uses integer seconds for SFTP/Python compatibility; the bytes catch same-size, same-mtime edits. */
export function textRevision(data: Buffer, metadata: readonly number[], truncated = false): string {
  return `${truncated ? 'preview' : 'v1'}:${createHash('sha256').update(JSON.stringify(metadata)).update('\0').update(data).digest('hex')}`;
}

export function validateExpectedRevision(revision: unknown): asserts revision is string {
  if (revision !== 'missing' && (typeof revision !== 'string' || !/^v1:[a-f0-9]{64}$/.test(revision))) {
    throw new Error('该文件没有可保存的完整版本，请重新打开；超过 2 MiB 的预览不能保存');
  }
}

export function textConflict(): Error {
  return new Error('TEXT_CONFLICT：文件自打开后已被修改、替换或删除，本次保存已停止。请重新读取并比较内容。');
}

export function decodeEditableText(data: Buffer, options: {
  encoding?: EditorEncoding; truncated: boolean; revision: string; size: number;
}): EditableTextFile {
  if (options.encoding !== undefined) validateEncoding(options.encoding);
  const bom = bomEncoding(data);
  let encoding = options.encoding ?? bom ?? 'utf8';
  // A UTF-8 BOM remains part of its encoding metadata even when UTF-8 was selected explicitly.
  if (encoding === 'utf8' && bom === 'utf8-bom') encoding = 'utf8-bom';
  const strip = encoding === bom ? (bom === 'utf8-bom' ? 3 : 2) : 0;
  const bytes = data.subarray(strip);
  let text: string;
  try {
    if (encoding === 'utf8' || encoding === 'utf8-bom' || encoding === 'utf16le' || encoding === 'utf16be') {
      const label = encoding.startsWith('utf8') ? 'utf-8' : encoding === 'utf16le' ? 'utf-16le' : 'utf-16be';
      text = new TextDecoder(label, { fatal: true, ignoreBOM: true }).decode(bytes, { stream: options.truncated });
    } else {
      const decoder = iconv.getDecoder(encoding, { stripBOM: false });
      text = decoder.write(bytes) + (options.truncated ? '' : decoder.end() ?? '');
      const encoded = iconv.encode(text, encoding);
      if (!encoded.equals(bytes.subarray(0, encoded.length)) || (!options.truncated && encoded.length !== bytes.length)) throw new Error('lossy decoding');
    }
  } catch {
    throw new Error(options.encoding === undefined
      ? 'TEXT_ENCODING_REQUIRED：文件不是有效的 UTF-8 文本，请选择原始编码后重新打开，避免乱码。'
      : 'TEXT_ENCODING_INVALID：文件与所选编码不匹配，无法无损读取，请更换编码。');
  }
  if (text.includes('\0')) throw new Error('文件包含二进制内容，不能作为文本编辑');
  return { text, truncated: options.truncated, encoding, lineEnding: detectLineEnding(text), revision: options.revision, size: options.size, bom: strip > 0 };
}

export function encodeEditableText(text: string, encoding: EditorEncoding, bom?: boolean): Buffer {
  validateEncoding(encoding);
  if (typeof text !== 'string' || text.includes('\0')) throw new Error('请输入不含 NUL 字符的文本');
  // JS strings can contain lone surrogates; Buffer/iconv would silently replace them.
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text)) {
    throw new Error('文本含有不完整的 Unicode 字符，未保存');
  }
  let data: Buffer;
  if (encoding === 'utf8' || encoding === 'utf8-bom') {
    data = Buffer.from(text, 'utf8');
    if (encoding === 'utf8-bom') data = Buffer.concat([utf8Bom, data]);
  } else if (encoding === 'utf16le' || encoding === 'utf16be') {
    data = Buffer.from(text, 'utf16le');
    if (encoding === 'utf16be') data.swap16();
    if (bom !== false) data = Buffer.concat([encoding === 'utf16le' ? littleBom : bigBom, data]);
  } else {
    data = iconv.encode(text, encoding);
    if (iconv.decode(data, encoding, { stripBOM: false }) !== text) throw new Error('TEXT_ENCODING_UNREPRESENTABLE：所选编码无法保存部分字符，请改用 UTF-8；原文件未改动。');
  }
  if (data.length > MAX_EDITABLE_TEXT) throw new Error('文本编辑最多支持 2 MiB，请使用文件传输');
  return data;
}

const writes = new Map<string, Promise<unknown>>();
export async function serializeTextWrite<T>(key: string, write: () => Promise<T>): Promise<T> {
  const pending = (writes.get(key) ?? Promise.resolve()).catch(() => {}).then(write);
  writes.set(key, pending);
  try { return await pending; }
  finally { if (writes.get(key) === pending) writes.delete(key); }
}

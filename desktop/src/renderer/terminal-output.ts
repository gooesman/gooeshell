type Base64ByteArrayConstructor = typeof Uint8Array & { fromBase64?: (value: string) => Uint8Array };

/** Compatibility path for browsers which do not expose the native byte decoder. */
export function decodeTerminalBytesFallback(value: string): Uint8Array {
  const raw = atob(value), bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index++) bytes[index] = raw.charCodeAt(index);
  return bytes;
}

/** Keep SSH output as bytes: UTF-8 sequences may span any two IPC messages. */
export function decodeTerminalBytes(value: string): Uint8Array {
  const bytes = Uint8Array as Base64ByteArrayConstructor;
  // Electron can decode directly into the byte array, avoiding an intermediate
  // binary string and a JavaScript callback for every byte of terminal output.
  return bytes.fromBase64 ? bytes.fromBase64(value) : decodeTerminalBytesFallback(value);
}

function unwrapError(error: unknown): string {
  let text = error instanceof Error ? error.message : String(error);
  // Electron adds an IPC wrapper around the original error, sometimes more than once.
  const prefix = /^(?:Error invoking remote method (?:'[^']*'|"[^"]*"):\s*|Error:\s*)/;
  while (prefix.test(text)) text = text.replace(prefix, '');
  return text;
}

export function isMissingCredentials(error: unknown): boolean {
  return /^(?:JUMP_)?AUTH_REQUIRED:/.test(unwrapError(error));
}

export function connectionErrorText(error: unknown): string {
  const text = unwrapError(error).replace(/^(?:(?:JUMP_)?AUTH_(?:REQUIRED|FAILED)|CREDENTIAL_[A-Z_]+|SUDO_PASSWORD_REQUIRED):\s*/, '');
  return text === 'All configured authentication methods failed'
    ? '身份验证失败，请检查账号、密码或密钥后重试。'
    : text;
}

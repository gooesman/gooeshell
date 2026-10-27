export function normalizeEditorExtension(value: string): string {
  const extension = value.trim().toLowerCase().replace(/^\*?\.?/, '');
  return /^[a-z0-9][a-z0-9_+-]{0,31}$/.test(extension) ? '.' + extension : '';
}

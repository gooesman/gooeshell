import type { Extension } from '@codemirror/state';
import { StreamLanguage } from '@codemirror/language';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { python } from '@codemirror/lang-python';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { markdown } from '@codemirror/lang-markdown';
import { xml } from '@codemirror/lang-xml';
import { yaml } from '@codemirror/lang-yaml';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { properties } from '@codemirror/legacy-modes/mode/properties';
import { nginx } from '@codemirror/legacy-modes/mode/nginx';
import { toml } from '@codemirror/legacy-modes/mode/toml';
import { dockerFile } from '@codemirror/legacy-modes/mode/dockerfile';

export const editorLanguages = [
  { id: 'auto', name: '自动识别' },
  { id: 'plain', name: '纯文本' },
  { id: 'shell', name: 'Shell' },
  { id: 'json', name: 'JSON' },
  { id: 'yaml', name: 'YAML' },
  { id: 'javascript', name: 'JavaScript' },
  { id: 'jsx', name: 'JavaScript JSX' },
  { id: 'typescript', name: 'TypeScript' },
  { id: 'tsx', name: 'TypeScript TSX' },
  { id: 'python', name: 'Python' },
  { id: 'html', name: 'HTML' },
  { id: 'css', name: 'CSS' },
  { id: 'markdown', name: 'Markdown' },
  { id: 'xml', name: 'XML' },
  { id: 'nginx', name: 'Nginx' },
  { id: 'toml', name: 'TOML' },
  { id: 'dockerfile', name: 'Dockerfile' },
  { id: 'properties', name: 'INI / 配置文件' },
] as const;

function detectedLanguage(path: string): string {
  const name = path.replace(/\\/g, '/').split('/').pop()?.toLowerCase() || '';
  if (/\.(sh|bash|zsh|fish)$/.test(name) || /^\.(bashrc|bash_profile|profile|zshrc)$/.test(name)) return 'shell';
  if (/\.(json|jsonc)$/.test(name)) return 'json';
  if (/\.(yaml|yml)$/.test(name)) return 'yaml';
  if (/\.[cm]?tsx?$/.test(name)) return name.endsWith('tsx') ? 'tsx' : 'typescript';
  if (/\.[cm]?jsx?$/.test(name)) return name.endsWith('jsx') ? 'jsx' : 'javascript';
  if (/\.(py|pyw)$/.test(name)) return 'python';
  if (/\.(html?|vue|svelte)$/.test(name)) return 'html';
  if (/\.(css|scss|less)$/.test(name)) return 'css';
  if (/\.(md|markdown)$/.test(name)) return 'markdown';
  if (/\.(xml|svg|xhtml)$/.test(name)) return 'xml';
  if (name === 'nginx.conf') return 'nginx';
  if (/\.toml$/.test(name)) return 'toml';
  if (/^dockerfile(?:\.|$)/.test(name)) return 'dockerfile';
  if (/\.(ini|conf|cfg|properties|service|socket|timer)$/.test(name) || /^\.env(?:\.|$)/.test(name)) return 'properties';
  return 'plain';
}

export function editorLanguage(path: string, selected = 'auto'): { id: string; name: string; extension: Extension } {
  const requested = selected === 'auto' ? detectedLanguage(path) : selected;
  const language = editorLanguages.find(language => language.id === requested) || editorLanguages[1];
  const extensions: Record<string, () => Extension> = {
    shell: () => StreamLanguage.define(shell),
    json, yaml,
    javascript: () => javascript(),
    jsx: () => javascript({ jsx: true }),
    typescript: () => javascript({ typescript: true }),
    tsx: () => javascript({ typescript: true, jsx: true }),
    python, html, css, markdown, xml,
    nginx: () => StreamLanguage.define(nginx),
    toml: () => StreamLanguage.define(toml),
    dockerfile: () => StreamLanguage.define(dockerFile),
    properties: () => StreamLanguage.define(properties),
  };
  return { ...language, extension: extensions[language.id]?.() || [] };
}

import type {AppSettings} from './types';

export const bundledFontFamilies = ['DejaVu Sans Mono', 'JetBrains Mono', 'IBM Plex Mono'] as const;

const recommendations = {
  english: ['DejaVu Sans Mono', 'JetBrains Mono', 'IBM Plex Mono', 'Cascadia Mono', 'Cascadia Code', 'Consolas', 'Ubuntu Mono', 'Noto Sans Mono'],
  chinese: ['Microsoft YaHei', '微软雅黑', 'Microsoft YaHei UI', '微软雅黑 UI', 'Sarasa Mono SC', '等距更纱黑体 SC', 'Noto Sans Mono CJK SC', 'Noto Sans CJK SC', 'Noto Sans SC', 'Source Han Sans SC', '思源黑体', 'Microsoft JhengHei', '微軟正黑體', 'SimSun', '宋体'],
} as const;

const identity = (font: string) => font.trim().toLocaleLowerCase();

export function isBundledFont(font: string): boolean {
  return bundledFontFamilies.some(item => identity(item) === identity(font));
}

export function availableFontFamilies(installed: readonly string[]): string[] {
  const unique = new Map<string, string>();
  for (const raw of [...bundledFontFamilies, ...installed]) {
    const font = raw.trim();
    // Windows also exposes vertical-writing aliases, which a terminal cannot use.
    if (font && !font.startsWith('@') && !unique.has(identity(font))) unique.set(identity(font), font);
  }
  return [...unique.values()].sort((a, b) => a.localeCompare(b, 'zh-CN'));
}

export function fontChoices(installed: readonly string[], language: keyof typeof recommendations, current: string) {
  const available = availableFontFamilies(installed);
  const byName = new Map(available.map(font => [identity(font), font]));
  const recommended = [...new Set(recommendations[language].flatMap(name => {
    const found = byName.get(identity(name));
    return found ? [found] : [];
  }))];
  const selected = byName.get(identity(current));
  return {
    recommended,
    other: available.filter(font => !recommended.includes(font)),
    missing: current && !selected ? current : '',
    selected: selected || current,
  };
}

export function terminalFontFamily(settings: Pick<AppSettings, 'fontFamily' | 'chineseFont'>): string {
  return `${JSON.stringify(settings.fontFamily)}, ${JSON.stringify(settings.chineseFont)}, monospace`;
}

export function terminalFontLoads(settings: Pick<AppSettings, 'fontFamily' | 'chineseFont' | 'fontSize' | 'fontWeight'>): string[] {
  // xterm measures cell dimensions with the normal face even when text is bold.
  const weights = [...new Set([400, settings.fontWeight, 700])];
  return [...new Set([settings.fontFamily, settings.chineseFont])].flatMap(family =>
    weights.map(weight => `${weight} ${settings.fontSize}px ${JSON.stringify(family)}`));
}

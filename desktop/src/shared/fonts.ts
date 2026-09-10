import type {AppSettings} from './types';
import type {FontFamilyInfo, FontFaceInfo} from './font-types';

export const bundledFontFamilies = ['DejaVu Sans Mono', 'JetBrains Mono', 'IBM Plex Mono'] as const;

export const bundledFontCatalog: FontFamilyInfo[] = [
  {family: 'DejaVu Sans Mono', faces: [
    {weight:400,style:'normal',localNames:[],url:'fonts/DejaVuSansMono.ttf'},
    {weight:700,style:'normal',localNames:[],url:'fonts/DejaVuSansMono-Bold.ttf'},
    {weight:400,style:'italic',localNames:[],url:'fonts/DejaVuSansMono-Oblique.ttf'},
    {weight:700,style:'italic',localNames:[],url:'fonts/DejaVuSansMono-BoldOblique.ttf'},
  ]},
  {family: 'JetBrains Mono', faces: [
    {weight:400,style:'normal',localNames:[],url:'fonts/JetBrainsMono-Regular.ttf'},
    {weight:700,style:'normal',localNames:[],url:'fonts/JetBrainsMono-Bold.ttf'},
  ]},
  {family: 'IBM Plex Mono', faces: [
    {weight:400,style:'normal',localNames:[],url:'fonts/IBMPlexMono-Regular.ttf'},
    {weight:700,style:'normal',localNames:[],url:'fonts/IBMPlexMono-Bold.ttf'},
  ]},
];

const recommendations = {
  english: ['DejaVu Sans Mono', 'JetBrains Mono', 'IBM Plex Mono', 'Cascadia Mono', 'Cascadia Code', 'Consolas', 'Ubuntu Mono', 'Noto Sans Mono'],
  chinese: ['Microsoft YaHei', '微软雅黑', 'Microsoft YaHei UI', '微软雅黑 UI', 'Sarasa Mono SC', '等距更纱黑体 SC', 'Noto Sans Mono CJK SC', 'Noto Sans CJK SC', 'Noto Sans SC', 'Source Han Sans SC', '思源黑体', 'Microsoft JhengHei', '微軟正黑體', 'SimSun', '宋体'],
} as const;

const identity = (font: string) => font.trim().toLocaleLowerCase();

export function mergeFontCatalog(system: readonly FontFamilyInfo[]): FontFamilyInfo[] {
  const families=new Map<string,FontFamilyInfo>();
  for(const item of [...system,...bundledFontCatalog])if(item.family&&!item.family.startsWith('@'))families.set(identity(item.family),item);
  return [...families.values()].sort((a,b)=>a.family.localeCompare(b.family,'zh-CN'));
}

export function findFont(catalog: readonly FontFamilyInfo[], family: string) {
  return catalog.find(item=>identity(item.family)===identity(family));
}

export function availableWeights(font?: FontFamilyInfo): number[] {
  return [...new Set(font?.faces.filter(face=>face.style==='normal').map(face=>face.weight)||[])].sort((a,b)=>a-b);
}

export function nearestWeight(weights: readonly number[], wanted: number): number {
  return [...weights].sort((a,b)=>Math.abs(a-wanted)-Math.abs(b-wanted)||a-b)[0]??wanted;
}

export function fontWeightLabel(weight: number) {
  const name=({100:'极细',200:'特细',290:'细体',300:'细体',350:'偏细',400:'普通',500:'中等',600:'半粗',700:'粗体',800:'特粗',900:'极粗'} as Record<number,string>)[weight];
  return `${name||'字重'} · ${weight}`;
}

export function selectFontFace(font: FontFamilyInfo, weight: number, style: 'normal'|'italic'='normal'): FontFaceInfo | undefined {
  const faces=font.faces.filter(face=>face.style===style);
  const selected=nearestWeight(faces.map(face=>face.weight),weight);
  return faces.find(face=>face.weight===selected);
}

// CJK ideographs, kana, hangul, punctuation and full-width forms use the Chinese slot.
const cjkRanges=[[0x2e80,0x9fff],[0xac00,0xd7af],[0xf900,0xfaff],[0xfe10,0xfe1f],[0xfe30,0xfe4f],[0xff00,0xffef],[0x20000,0x323af]];
const rangeText=(ranges:number[][])=>ranges.map(([from,to])=>`U+${from.toString(16)}-${to.toString(16)}`).join(',');
const otherRanges:number[][]=[];let start=0;
for(const [from,to] of cjkRanges){if(start<from)otherRanges.push([start,from-1]);start=to+1;}otherRanges.push([start,0x10ffff]);
export const chineseUnicodeRange=rangeText(cjkRanges);
export const englishUnicodeRange=rangeText(otherRanges);

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

export function terminalFontLoads(settings: Pick<AppSettings, 'fontFamily' | 'chineseFont' | 'fontSize' | 'fontWeight'> & Partial<Pick<AppSettings,'chineseFontWeight'>>): string[] {
  // xterm measures cell dimensions with the normal face even when text is bold.
  const weights = [...new Set([400, settings.fontWeight, settings.chineseFontWeight??settings.fontWeight, 700])];
  return [...new Set([settings.fontFamily, settings.chineseFont])].flatMap(family =>
    weights.map(weight => `${weight} ${settings.fontSize}px ${JSON.stringify(family)}`));
}

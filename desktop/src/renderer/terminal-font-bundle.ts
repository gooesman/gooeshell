import type {AppSettings} from '../shared/types';
import type {FontFamilyInfo,FontFaceInfo} from '../shared/font-types';
import {api} from './api';
import {mergeFontCatalog,findFont,selectFontFace,availableWeights,chineseUnicodeRange,englishUnicodeRange,terminalFontFamily} from '../shared/fonts';

let catalogPromise:Promise<FontFamilyInfo[]>|undefined;
export function loadFontCatalog() {
  return catalogPromise??=(api.fontCatalog().then(mergeFontCatalog).catch(error=>{catalogPromise=undefined;throw error;}));
}

type Selection=Pick<AppSettings,'fontFamily'|'chineseFont'|'fontWeight'|'chineseFontWeight'>;
export interface TerminalFontBundle {family:string;englishWeight:number;chineseWeight:number;warnings:string[];release:()=>void;}
interface CacheEntry {refs:number;used:number;faces:FontFace[];promise:Promise<Omit<TerminalFontBundle,'release'>>;}
const cache=new Map<string,CacheEntry>();
let serial=0;
function prune() {
  const unused=[...cache].filter(([,entry])=>!entry.refs).sort((a,b)=>b[1].used-a[1].used);
  for(const [key,entry] of unused.slice(8)){for(const face of entry.faces)document.fonts.delete(face);cache.delete(key);}
}
function source(face:FontFaceInfo) {
  if(face.url){
    const base=import.meta.env.DEV?new URL('/',location.href):new URL('.',document.baseURI);
    return `url(${JSON.stringify(new URL(face.url,base).href)})`;
  }
  return face.localNames.map(name=>`local(${JSON.stringify(name)})`).join(',');
}

export async function acquireTerminalFont(settings:Selection,catalog:readonly FontFamilyInfo[]):Promise<TerminalFontBundle> {
  const english=findFont(catalog,settings.fontFamily),chinese=findFont(catalog,settings.chineseFont);
  if(!english?.faces.length||!chinese?.faces.length)throw new Error('无法识别所选字体的字重，请选择可用字体。');
  const key=JSON.stringify([english,chinese,settings.fontWeight,settings.chineseFontWeight]);
  let entry=cache.get(key);
  if(!entry){
    const alias=`GooeshellTerminal${++serial}`;
    const faces:FontFace[]=[];
    entry={refs:0,used:Date.now(),faces,promise:Promise.resolve(null as never)};
    const created=entry;
    created.promise=(async()=>{
      const warnings:string[]=[];
      const actual:number[]=[];
      for(const [font,wanted,range,label] of [[english,settings.fontWeight,englishUnicodeRange,'英文'],[chinese,settings.chineseFontWeight,chineseUnicodeRange,'中文']] as const){
        const normal=selectFontFace(font,wanted);
        if(!normal)throw new Error(`${label}字体没有可用的普通字形。`);
        actual.push(normal.weight);
        if(normal.weight!==wanted)warnings.push(`${label}字体不提供 ${wanted} 字重，使用 ${normal.weight}。`);
        for(const logical of [400,700])for(const style of ['normal','italic'] as const){
          const face=selectFontFace(font,logical===400?wanted:Math.max(700,wanted),style);
          if(!face)continue;
          // Generic system fallback has no font file; the trailing CSS family renders it.
          if(!face.url&&!face.localNames.length)continue;
          // Let the browser synthesize ANSI bold for fonts that have no physical bold face.
          if(logical===700&&face.weight<700)continue;
          // Each language maps its physical face onto xterm's normal/bold slots.
          const value=new FontFace(alias,source(face),{weight:String(logical),style,unicodeRange:range,display:'block'});
          faces.push(value);
        }
      }
      try{await Promise.all(faces.map(face=>face.load()));for(const face of faces)document.fonts.add(face);}
      catch{for(const face of faces)document.fonts.delete(face);throw new Error('所选字重的字体文件加载失败，请选择其他字体。');}
      // A Latin family can contain CJK glyphs too: keep synthesized Chinese bold in its chosen family.
      const chineseFirst=!availableWeights(chinese).some(weight=>weight>=700)&&availableWeights(english).some(weight=>weight>=700);
      const fallback=chineseFirst?terminalFontFamily({fontFamily:settings.chineseFont,chineseFont:settings.fontFamily}):terminalFontFamily(settings);
      return {family:`${JSON.stringify(alias)}, ${fallback}`,englishWeight:actual[0],chineseWeight:actual[1],warnings};
    })();
    cache.set(key,created);
  }
  entry.refs++;entry.used=Date.now();
  const held=entry;
  try{
    const value=await held.promise;let released=false;
    return {...value,release:()=>{if(released)return;released=true;held.refs--;held.used=Date.now();prune();}};
  }catch(error){held.refs--;if(cache.get(key)===held)cache.delete(key);throw error;}
}

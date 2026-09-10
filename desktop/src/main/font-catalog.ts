import {execFile} from 'node:child_process';
import {promises as fs} from 'node:fs';
import type {FileHandle} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import type {FontFaceInfo,FontFamilyInfo} from '../shared/font-types';

// WPF exposes synthetic bold/oblique faces too. Only physical glyph faces belong
// in the catalog; otherwise SimSun incorrectly appears to provide a bold font.
const catalogScript=String.raw`
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName PresentationCore
function OrderedNames($names) {
  @($names.GetEnumerator() | Sort-Object @{Expression={if ($_.Key.Name -eq 'en-US' -or $_.Key.IetfLanguageTag -eq 'en-US') {0} elseif ($_.Key.Name -like 'en-*' -or $_.Key.IetfLanguageTag -like 'en-*') {1} else {2}}}, @{Expression={$_.Key.ToString()}})
}
function Candidates($families,$faces) {
  $orderedFaces=@(OrderedNames $faces)
  foreach ($entry in @(OrderedNames $families)) {
    $face=$orderedFaces | Where-Object {$_.Key.ToString() -eq $entry.Key.ToString()} | Select-Object -First 1
    if ($null -eq $face) {$face=$orderedFaces | Select-Object -First 1}
    if ($null -ne $face) {"$($entry.Value) $($face.Value)"}
    $english=$orderedFaces | Where-Object {$_.Key.Name -like 'en-*'} | Select-Object -First 1
    if ($null -ne $english -and $english.Value -in @('Regular','Normal','Roman')) {$entry.Value}
  }
}
$result=@(foreach ($family in [System.Windows.Media.Fonts]::SystemFontFamilies) {
  try {
    foreach ($face in $family.GetTypefaces()) {
      $glyph=$null
      if (-not $face.TryGetGlyphTypeface([ref]$glyph)) {continue}
      if ($face.IsBoldSimulated -or $face.IsObliqueSimulated -or $glyph.StyleSimulations.ToString() -ne 'None') {continue}
      $families=@($family.Source; (OrderedNames $family.FamilyNames).Value; (OrderedNames $glyph.FamilyNames).Value; (OrderedNames $glyph.Win32FamilyNames).Value) | Where-Object {$_ -and -not $_.StartsWith('@')} | Select-Object -Unique
      $names=@(Candidates $glyph.FamilyNames $glyph.FaceNames; Candidates $glyph.Win32FamilyNames $glyph.Win32FaceNames) | Select-Object -Unique
      [pscustomobject]@{
        families=@($families); weight=$glyph.Weight.ToOpenTypeWeight();
        style=$(if ($glyph.Style.ToString() -eq 'Normal') {'normal'} else {'italic'});
        stretch=$glyph.Stretch.ToOpenTypeStretch(); localNames=@($names); uri=$glyph.FontUri.AbsoluteUri
      }
    }
  } catch { }
})
ConvertTo-Json -InputObject $result -Depth 5 -Compress
`;

type CatalogFace={families:string[];weight:number;style:'normal'|'italic';stretch:number;localNames:string[];uri:string};
const fontName=(value:unknown):value is string=>typeof value==='string'&&!!value.trim()&&value.length<=512&&!/[\0\r\n]/.test(value);
const uniqueNames=(values:readonly string[])=>[...new Map(values.filter(fontName).map(value=>[value.toLowerCase(),value.trim()])).values()];

/** Read only the small OpenType name table, including a selected TTC face. */
export async function readFontLocalNames(fontUri:string):Promise<string[]>{
  const uri=new URL(fontUri);
  if(uri.protocol!=='file:')return[];
  const faceIndex=uri.hash?Number(uri.hash.slice(1)):0;
  if(!Number.isSafeInteger(faceIndex)||faceIndex<0||faceIndex>4095)return[];
  uri.hash='';
  const file=await fs.open(fileURLToPath(uri),'r');
  try{
    const size=(await file.stat()).size;
    const read=async(position:number,length:number)=>readRange(file,position,length,size);
    const header=await read(0,12);
    let fontOffset=0;
    if(header.toString('ascii',0,4)==='ttcf'){
      if(faceIndex>=header.readUInt32BE(8))return[];
      fontOffset=(await read(12+faceIndex*4,4)).readUInt32BE(0);
    }else if(faceIndex!==0)return[];
    const fontHeader=fontOffset?await read(fontOffset,12):header;
    const tables=fontHeader.readUInt16BE(4);
    if(tables>4096)return[];
    const records=await read(fontOffset+12,tables*16);
    for(let offset=0;offset<records.length;offset+=16){
      if(records.toString('ascii',offset,offset+4)!=='name')continue;
      const position=records.readUInt32BE(offset+8),length=records.readUInt32BE(offset+12);
      if(length>2*1024*1024)return[];
      return decodeFontLocalNames(await read(position,length));
    }
    return[];
  }finally{await file.close();}
}

async function readRange(file:FileHandle,position:number,length:number,fileSize:number):Promise<Buffer>{
  if(position<0||length<0||position+length>fileSize)throw new Error('Invalid font table bounds');
  const data=Buffer.alloc(length);let offset=0;
  while(offset<length){const result=await file.read(data,offset,length-offset,position+offset);if(!result.bytesRead)throw new Error('Truncated font table');offset+=result.bytesRead;}
  return data;
}

// CSS local() matches full names or PostScript names, not arbitrary family names.
// https://learn.microsoft.com/en-us/typography/opentype/spec/name#name-ids
export function decodeFontLocalNames(table:Buffer):string[]{
  if(table.length<6)return[];
  const count=table.readUInt16BE(2),strings=table.readUInt16BE(4);
  if(6+count*12>table.length||strings>table.length)return[];
  const names:{value:string;priority:number}[]=[];
  for(let index=0;index<count;index++){
    const at=6+index*12,platform=table.readUInt16BE(at),encoding=table.readUInt16BE(at+2),language=table.readUInt16BE(at+4),id=table.readUInt16BE(at+6);
    if(id!==4&&id!==6)continue;
    const length=table.readUInt16BE(at+8),start=strings+table.readUInt16BE(at+10);
    if(start+length>table.length)continue;
    const bytes=table.subarray(start,start+length);let value='';
    if(platform===0||(platform===3&&[0,1,10].includes(encoding))){
      if(length%2)continue;
      value=Buffer.from(bytes).swap16().toString('utf16le');
    }else if(platform===1&&encoding===0&&bytes.every(byte=>byte<128))value=bytes.toString('ascii');
    if(!fontName(value))continue;
    const english=platform===3&&(language&0x3ff)===9||platform===1&&language===0;
    names.push({value:value.trim(),priority:(english?0:platform===0?2:4)+(id===6?1:0)});
  }
  return uniqueNames(names.sort((a,b)=>a.priority-b.priority).map(name=>name.value));
}

function parseFaces(input:unknown):CatalogFace[]{
  if(!Array.isArray(input))return[];
  return input.flatMap(value=>{
    if(!value||typeof value!=='object'||!Number.isInteger(value.weight)||value.weight<1||value.weight>1000||!['normal','italic'].includes(value.style))return[];
    const families=uniqueNames(Array.isArray(value.families)?value.families:[]).filter(name=>!name.startsWith('@'));
    if(!families.length)return[];
    return[{families,weight:value.weight,style:value.style,stretch:Number.isInteger(value.stretch)?value.stretch:5,localNames:uniqueNames(Array.isArray(value.localNames)?value.localNames:[]),uri:typeof value.uri==='string'?value.uri:''}];
  });
}

export function groupFontCatalog(faces:readonly CatalogFace[]):FontFamilyInfo[]{
  const families=new Map<string,{family:string;faces:Map<string,{face:FontFaceInfo;stretch:number}>}>();
  for(const raw of faces){
    if(!raw.localNames.length)continue;
    for(const name of raw.families){
      const key=name.toLowerCase();const family=families.get(key)??{family:name,faces:new Map()};families.set(key,family);
      const faceKey=`${raw.weight}/${raw.style}`;const previous=family.faces.get(faceKey);
      const distance=Math.abs(raw.stretch-5),previousDistance=previous?Math.abs(previous.stretch-5):Infinity;
      if(distance>previousDistance)continue;
      const localNames=distance===previousDistance&&previous?uniqueNames([...previous.face.localNames,...raw.localNames]):raw.localNames;
      family.faces.set(faceKey,{face:{weight:raw.weight,style:raw.style,localNames},stretch:raw.stretch});
    }
  }
  return[...families.values()].map(({family,faces})=>({family,faces:[...faces.values()].map(item=>item.face).sort((a,b)=>a.weight-b.weight||a.style.localeCompare(b.style))})).sort((a,b)=>a.family.localeCompare(b.family,'zh-CN'));
}

let pendingCatalog:Promise<FontFamilyInfo[]>|undefined;
export function systemFontCatalog():Promise<FontFamilyInfo[]>{
  if(process.platform!=='win32')return Promise.resolve([]);
  if(!pendingCatalog){
    pendingCatalog=new Promise<string>((resolve,reject)=>execFile('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(catalogScript,'utf16le').toString('base64')],{windowsHide:true,timeout:30000,maxBuffer:8*1024*1024},(error,out)=>error?reject(new Error('无法读取系统字体字重：'+error.message)):resolve(out)))
      .then(async output=>{
        const faces=parseFaces(JSON.parse(output.replace(/^\ufeff/,'')));
        const names=new Map<string,string[]>();const uris=[...new Set(faces.map(face=>face.uri))];let next=0;
        await Promise.all(Array.from({length:Math.min(8,uris.length)},async()=>{
          while(next<uris.length){const uri=uris[next++];names.set(uri,await readFontLocalNames(uri).catch(()=>[]));}
        }));
        for(const face of faces)face.localNames=uniqueNames([...(names.get(face.uri)??[]),...face.localNames]);
        return groupFontCatalog(faces);
      });
    void pendingCatalog.catch(()=>{pendingCatalog=undefined;});
  }
  return pendingCatalog;
}

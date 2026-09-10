import type {FontFamilyInfo} from '../shared/font-types';

// Browser-only demo: advertise a system face only after its exact local name loads.
export async function previewFontCatalog():Promise<FontFamilyInfo[]> {
  const result:FontFamilyInfo[]=[];
  for(const family of ['Microsoft YaHei','Microsoft YaHei UI','SimSun','Consolas','Cascadia Code']){
    const faces:FontFamilyInfo['faces']=[];
    for(const [weight,name] of [[400,family],[700,`${family} Bold`]] as const){
      try{await new FontFace('GooeshellProbe',`local(${JSON.stringify(name)})`).load();faces.push({weight,style:'normal',localNames:[name]});}catch{/* Unavailable faces are omitted. */}
    }
    if(faces.length)result.push({family,faces});
  }
  return result;
}

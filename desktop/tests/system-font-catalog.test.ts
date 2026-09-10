import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {decodeFontLocalNames,groupFontCatalog,readFontLocalNames,systemFontCatalog} from '../src/main/font-catalog';

function nameTable(entries:{value:string;id:number;language?:number;platform?:number}[]):Buffer{
  const encoded=entries.map(entry=>entry.platform===1?Buffer.from(entry.value,'ascii'):Buffer.from(entry.value,'utf16le').swap16());
  const start=6+entries.length*12;const table=Buffer.alloc(start+encoded.reduce((total,value)=>total+value.length,0));
  table.writeUInt16BE(entries.length,2);table.writeUInt16BE(start,4);let next=0;
  entries.forEach((entry,index)=>{
    const offset=6+index*12,bytes=encoded[index];
    table.writeUInt16BE(entry.platform??3,offset);table.writeUInt16BE(entry.platform===1?0:1,offset+2);
    table.writeUInt16BE(entry.language??0x409,offset+4);table.writeUInt16BE(entry.id,offset+6);
    table.writeUInt16BE(bytes.length,offset+8);table.writeUInt16BE(next,offset+10);bytes.copy(table,start+next);next+=bytes.length;
  });return table;
}

test('font local names prefer the actual English full and PostScript names and preserve Chinese aliases',()=>{
  const table=nameTable([
    {value:'字体名称 Bold',id:4,language:0x804},
    {value:'Font Bold',id:4},
    {value:'Font-Bold',id:6},
    {value:'Font',id:1},
    {value:'Bold',id:2},
    {value:'Font Bold',id:4,platform:1,language:0},
    {value:'unsafe\0name',id:4},
  ]);
  assert.deepEqual(decodeFontLocalNames(table),['Font Bold','Font-Bold','字体名称 Bold']);
  assert.deepEqual(decodeFontLocalNames(table.subarray(0,10)),[]);
  const invalid=Buffer.from(table);invalid.writeUInt16BE(65535,4);assert.deepEqual(decodeFontLocalNames(invalid),[]);
});

test('font collection parsing selects the requested TTC face instead of reusing the first font name',async()=>{
  const base=path.resolve('test-output');await fs.mkdir(base,{recursive:true});
  const directory=await fs.mkdtemp(path.join(base,'font-catalog-'));
  try{
    const first=nameTable([{value:'Family Bold',id:4},{value:'Family-Bold',id:6}]);
    const second=nameTable([{value:'Family UI Bold',id:4},{value:'FamilyUI-Bold',id:6}]);
    const data=Buffer.alloc(76+first.length+second.length);data.write('ttcf');data.writeUInt32BE(0x10000,4);data.writeUInt32BE(2,8);data.writeUInt32BE(20,12);data.writeUInt32BE(48,16);
    for(const [fontOffset,tableOffset,table] of [[20,76,first],[48,76+first.length,second]] as const){
      data.writeUInt32BE(0x10000,fontOffset);data.writeUInt16BE(1,fontOffset+4);data.write('name',fontOffset+12);
      data.writeUInt32BE(tableOffset,fontOffset+20);data.writeUInt32BE(table.length,fontOffset+24);table.copy(data,tableOffset);
    }
    const file=path.join(directory,'fixture.ttc');await fs.writeFile(file,data);const uri=pathToFileURL(file).href;
    assert.deepEqual(await readFontLocalNames(uri),['Family Bold','Family-Bold']);
    assert.deepEqual(await readFontLocalNames(uri+'#1'),['Family UI Bold','FamilyUI-Bold']);
    assert.deepEqual(await readFontLocalNames(uri+'#2'),[]);
    assert.deepEqual(await readFontLocalNames(uri+'#invalid'),[]);
    data.writeUInt32BE(data.length+100,68);await fs.writeFile(file,data);
    await assert.rejects(readFontLocalNames(uri+'#1'),/font table bounds/);
  }finally{assert.ok(directory.startsWith(base+path.sep));await fs.rm(directory,{recursive:true,force:true});}
});

test('font families keep their actual weights and aliases and prefer normal width for matching faces',()=>{
  const regular={families:['Example','示例'],weight:400,style:'normal' as const,stretch:5,uri:'',localNames:['Example Regular']};
  const faces=[
    {...regular,stretch:3,localNames:['Example Condensed']},
    regular,
    {...regular,weight:700,localNames:['Example Bold']},
    {...regular,style:'italic' as const,localNames:['Example Italic']},
    {...regular,families:['Regular Only'],localNames:['Regular Only']},
  ];
  const catalog=groupFontCatalog(faces);const example=catalog.find(family=>family.family==='Example')!;
  assert.equal(example.faces.length,3);
  assert.deepEqual(example.faces.find(face=>face.weight===400&&face.style==='normal')?.localNames,['Example Regular']);
  assert.deepEqual(catalog.find(family=>family.family==='示例')?.faces,example.faces);
  assert.deepEqual(catalog.find(family=>family.family==='Regular Only')?.faces.map(face=>face.weight),[400]);
});

test('Windows catalog reports physical YaHei regular/bold and excludes simulated SimSun bold',{
  skip:process.platform==='win32'&&process.env.GOOESHELL_FONT_CATALOG_TEST==='1'?false:'Set GOOESHELL_FONT_CATALOG_TEST=1 on a Windows fixture with YaHei and SimSun',timeout:45000,
},async()=>{
  const catalog=await systemFontCatalog();assert.ok(catalog.length>0);
  for(const family of ['Microsoft YaHei','微软雅黑','Microsoft YaHei UI']){
    const info=catalog.find(item=>item.family===family);assert.ok(info,`${family} should be enumerated`);
    assert.ok(info.faces.some(face=>face.weight===400&&face.style==='normal'));
    assert.ok(info.faces.some(face=>face.weight===700&&face.style==='normal'));
  }
  const bold=catalog.find(item=>item.family==='Microsoft YaHei')!.faces.find(face=>face.weight===700&&face.style==='normal')!;
  assert.equal(bold.localNames[0],'Microsoft YaHei Bold');assert.ok(bold.localNames.includes('MicrosoftYaHei-Bold'));
  const uiBold=catalog.find(item=>item.family==='Microsoft YaHei UI')!.faces.find(face=>face.weight===700&&face.style==='normal')!;
  assert.equal(uiBold.localNames[0],'Microsoft YaHei UI Bold');assert.ok(!uiBold.localNames.includes('Microsoft YaHei Bold'));
  for(const family of ['SimSun','宋体']){
    assert.deepEqual(catalog.find(item=>item.family===family)?.faces.map(face=>[face.weight,face.style]),[[400,'normal']]);
  }
  assert.strictEqual(await systemFontCatalog(),catalog,'repeat requests should reuse the completed catalog');
});

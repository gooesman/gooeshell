import test from 'node:test';
import assert from 'node:assert/strict';
import {parentPath} from '../src/shared/file-paths';
import {terminalFontFamily,terminalFontLoads} from '../src/shared/fonts';

test('parent navigation preserves POSIX roots on macOS/Linux and Windows drive roots',()=>{
  for(const side of ['local','remote'] as const){
    assert.equal(parentPath('/home/developer',side),'/home');
    assert.equal(parentPath('/home/',side),'/');
    assert.equal(parentPath('/',side),'/');
    assert.equal(parentPath('/folder\\name',side),'/');
  }
  assert.equal(parentPath('C:\\Users\\developer','local'),'C:\\Users');
  assert.equal(parentPath('C:\\Users','local'),'C:\\');
  assert.equal(parentPath('C:\\','local'),'C:\\');
});

test('generic CJK fallback uses CSS keyword syntax instead of a nonexistent quoted family',()=>{
  const settings={fontFamily:'DejaVu Sans Mono',chineseFont:'sans-serif',fontWeight:400,fontSize:14};
  assert.equal(terminalFontFamily(settings),'"DejaVu Sans Mono", sans-serif, monospace');
  assert.ok(terminalFontLoads(settings).includes('400 14px sans-serif'));
});

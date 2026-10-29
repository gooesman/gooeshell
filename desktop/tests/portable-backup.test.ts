import test from 'node:test';
import assert from 'node:assert/strict';
import {decryptBackup,encryptBackup} from '../src/main/portable-backup';

test('portable encrypted backup restores data and rejects wrong passwords and tampering',async()=>{
  const original={connections:[{name:'测试',host:'fixture.invalid'}],password:'fixture-only-secret'};
  const file=await encryptBackup(original,'fixture-passphrase');
  assert(!file.includes('fixture-only-secret'));assert.deepEqual(await decryptBackup(file,'fixture-passphrase'),original);
  assert.notEqual(file,await encryptBackup(original,'fixture-passphrase'));
  await assert.rejects(decryptBackup(file,'wrong-passphrase'),/密码错误或文件已损坏/);
  const tampered=JSON.parse(file);const bytes=Buffer.from(tampered.data,'base64');bytes[0]^=1;tampered.data=bytes.toString('base64');
  await assert.rejects(decryptBackup(JSON.stringify(tampered),'fixture-passphrase'),/密码错误或文件已损坏/);
  await assert.rejects(encryptBackup(original,'short'),/8 至/);
  tampered.version=2;await assert.rejects(decryptBackup(JSON.stringify(tampered),'fixture-passphrase'),/不支持/);
});

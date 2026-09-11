import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {test} from 'node:test';
import {cleanJumpProfile,jumpCredentialProfile} from '../src/main/jump-profile';
import {cleanProfile} from '../src/main/store';
import {connectionIdentity,sameConnection} from '../src/shared/connections';
import type {HostProfile,JumpHostProfile} from '../src/shared/types';

const jump:JumpHostProfile={id:'bastion',name:'Bastion',host:'gateway.example.test',port:22,username:'gateway-user',auth:'password',rememberHost:true,reuseConnection:true};
const target:HostProfile={id:'target',name:'Private server',host:'10.0.0.8',port:22,username:'work',auth:'password',rememberHost:true,encoding:'utf8'};

test('jump profiles preserve only an explicit single-hop snapshot and exclude all secrets',()=>{
  const input={...jump,id:' bastion ',name:' ',host:' [2001:db8::10] ',username:' gateway-user ',password:'not-a-profile-field',passphrase:'also-secret',sudoPassword:'sudo-secret',credentials:{password:'nested-secret'},encoding:'big5',groupId:'outside'};
  assert.deepEqual(cleanJumpProfile(input),{...jump,name:'2001:db8::10',host:'2001:db8::10',privateKeyPath:''});
  const profile=cleanProfile({...target,jumpHost:input});
  assert.deepEqual(profile.jumpHost,cleanJumpProfile(input));
  assert.ok(!JSON.stringify(profile).includes('secret'));
  assert.equal(cleanJumpProfile({...jump,auth:'key',privateKeyPath:' /keys/gateway '}).privateKeyPath,'/keys/gateway');
});

test('malformed or nested jump settings reject the connection rather than becoming direct SSH',()=>{
  for(const invalid of [null,[],{},'',{...jump,id:''},{...jump,id:'x'.repeat(256)},{...jump,id:'bad\nvalue'},
    {...jump,host:''},{...jump,host:'[]'},{...jump,host:'bad\0host'},{...jump,username:''},
    {...jump,port:0},{...jump,port:65536},{...jump,port:'22'},{...jump,auth:'unknown'},
    {...jump,rememberHost:1},{...jump,reuseConnection:undefined},{...jump,auth:'key'},
    {...jump,privateKeyPath:'bad\0key'},{...jump,jumpHost:jump},{...jump,jumpHost:null},
  ]){
    assert.throws(()=>cleanJumpProfile(invalid),/跳板机/);
    assert.throws(()=>cleanProfile({...target,jumpHost:invalid as JumpHostProfile}),/跳板机/);
  }
  assert.equal(cleanProfile({...target,jumpHost:undefined}).jumpHost,undefined);
});

test('route identities distinguish private destinations while direct identity stays backward compatible',()=>{
  const direct={...target,host:' [2001:DB8::8] ',username:' work ',auth:'key' as const,privateKeyPath:' /keys/target '};
  const legacy='["2001:db8::8",22,"work","key","/keys/target"]';
  assert.equal(connectionIdentity(direct),legacy);
  assert.equal(connectionIdentity({...direct,name:'Renamed',id:'different',encoding:'big5',rememberHost:false}),legacy);
  const routed={...target,jumpHost:jump};
  assert.notEqual(connectionIdentity(routed),connectionIdentity(target));
  for(const changes of [{host:'other-gateway.example.test'},{port:2222},{username:'other-user'},{auth:'agent' as const},{auth:'key' as const,privateKeyPath:'/keys/first'}]){
    assert.notEqual(connectionIdentity(routed),connectionIdentity({...routed,jumpHost:{...jump,...changes}}));
  }
  const metadata={...routed,jumpHost:{...jump,id:'another-preset',name:'Renamed',reuseConnection:false,rememberHost:false,host:' GATEWAY.example.test ',username:' gateway-user '}};
  assert.equal(connectionIdentity(routed),connectionIdentity(metadata));
  assert.equal(sameConnection(routed,metadata),true);
  assert.equal(sameConnection(target,routed),false);
  const keyRoute={...routed,jumpHost:{...jump,auth:'key' as const,privateKeyPath:'/keys/first'}};
  assert.notEqual(connectionIdentity(keyRoute),connectionIdentity({...keyRoute,jumpHost:{...keyRoute.jumpHost,privateKeyPath:'/keys/second'}}));
});

test('jump credential ids use a deterministic namespace separate from target ids',()=>{
  const credential=jumpCredentialProfile({...jump,id:target.id});
  assert.equal(credential.id,`jump:${createHash('sha256').update(target.id).digest('hex')}`);
  assert.notEqual(credential.id,target.id);
  assert.equal(credential.jumpHost,undefined);
  assert.equal(credential.encoding,'utf8');
  assert.equal(credential.host,jump.host);
  assert.equal(jumpCredentialProfile({...jump,id:` ${target.id} `,name:'Renamed',reuseConnection:false}).id,credential.id);
  assert.notEqual(jumpCredentialProfile({...jump,id:'another-preset'}).id,credential.id);
  assert.throws(()=>jumpCredentialProfile({...jump,id:'x'.repeat(256)}),/跳板机/);
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DeviceCredentialSchema,PHONE_SCOPES,REMOTE_SCOPES,DEVICE_CREDENTIAL_LIFETIME_MS} from '../dist/device-auth.js';

const credential={protocolVersion:'0.1.0',deviceId:'0b7e8a5c-2d43-4c4e-9f0e-6a1d2b3c4d5e',token:'A'.repeat(43),expiresAt:1_800_000_000_000,scopes:[...PHONE_SCOPES]};

test('phone scopes are known, unique, and meet the phone keychain rule (health plus at least one more)',()=>{
 assert.ok(PHONE_SCOPES.every(scope=>REMOTE_SCOPES.includes(scope)));
 assert.equal(new Set(PHONE_SCOPES).size,PHONE_SCOPES.length);
 assert.ok(PHONE_SCOPES.includes('generation:health')&&PHONE_SCOPES.length>=2);
 assert.ok(PHONE_SCOPES.includes('printer-handoff:use'));
 assert.equal(DEVICE_CREDENTIAL_LIFETIME_MS,30*24*60*60*1000);
});

test('the device credential keeps the first protocol shape exactly',()=>{
 assert.deepEqual(DeviceCredentialSchema.parse(credential),credential);
 for(const bad of [{...credential,protocolVersion:'0.2.0'},{...credential,token:'short'},{...credential,scopes:['generation:health','generation:health']},
  {...credential,scopes:['printer:dispatch']},{...credential,extra:true},{...credential,expiresAt:0}])
  assert.equal(DeviceCredentialSchema.safeParse(bad).success,false);
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {formatPairingLink,isPairingLink,parsePairingLink,PAIRING_LINK_MAX_ADDRESSES} from '../dist/pairing-link.js';

const code='A'.repeat(16)+'b_-'.repeat(5)+'z';
const now=1_800_000_000_000,expiresAt=now+300_000;
const certificate='0f'.repeat(32),publicKey='ab'.repeat(32);
const code_=(fn,expected)=>assert.throws(fn,e=>e.code===expected);
const invalid=fn=>code_(fn,'invalid-invitation');
// The companion's v1 link as main built it before this contract existed.
const legacy=(u,pin)=>{const q=new URLSearchParams({v:'1',u,c:code,e:String(expiresAt)});if(pin)q.set('f',pin);return `scantomake://pair?${q}`;};
const v2=(extra='',addresses=['https://192.168.68.123:9077','https://davids-mac-mini.local:9077','https://100.101.102.103:9077'])=>
 `scantomake://pair?v=2&c=${code}&e=${expiresAt}&k=${publicKey}${addresses.map(a=>'&a='+encodeURIComponent(a)).join('')}${extra}`;

test('v1 links parse exactly as before, with and without the certificate pin f',()=>{
 assert.deepEqual(parsePairingLink(legacy('https://mac.tail1234.ts.net'),now),{version:1,baseUrl:'https://mac.tail1234.ts.net',code,expiresAt});
 assert.deepEqual(parsePairingLink(legacy('https://192.168.1.20:9077',certificate),now),
  {version:1,baseUrl:'https://192.168.1.20:9077',code,expiresAt,certificateSha256:certificate});
 assert.equal(parsePairingLink(legacy('https://mac.tail1234.ts.net/')).baseUrl,'https://mac.tail1234.ts.net/');
 for(const host of ['https://mac.local','https://mac:9077','https://[fd00::1]:9077','https://studio.office.local:9077'])
  assert.equal(parsePairingLink(legacy(host,certificate)).baseUrl,host);
 // Unpinned means Tailscale Serve; a pin means an address iOS lets a private certificate use.
 for(const host of ['https://192.168.1.20:9077','https://mac.local','https://mac.example.com','https://mac.tail1234.ts.net:8443'])invalid(()=>parsePairingLink(legacy(host)));
 invalid(()=>parsePairingLink(legacy('https://mac.example.com',certificate)));
 for(const bad of [certificate.toUpperCase(),certificate.slice(1),certificate+'0'])invalid(()=>parsePairingLink(legacy('https://192.168.1.20:9077',bad)));
 for(const bad of [legacy('https://user@mac.tail1234.ts.net'),legacy('https://mac.tail1234.ts.net/extra'),legacy('http://mac.tail1234.ts.net'),
  legacy('https://mac.tail1234.ts.net').replace(code,'short'),'https://example.com/pair?c=x','hello'])invalid(()=>parsePairingLink(bad));
});

test('the formatter writes v1 byte-for-byte as main did, and round-trips',()=>{
 for(const [u,pin] of [['https://mac.tail1234.ts.net'],['https://192.168.68.123:9077',certificate],['https://[fd00::1]:9077',certificate]]){
  const link={version:1,baseUrl:u,code,expiresAt,...(pin?{certificateSha256:pin}:{})};
  assert.equal(formatPairingLink(link),legacy(u,pin));
  assert.deepEqual(parsePairingLink(formatPairingLink(link)),link);
 }
});

test('v2 carries every address in order, the public-key pin and an optional name',()=>{
 assert.deepEqual(parsePairingLink(v2('&n='+encodeURIComponent("David's Mac mini")),now),{
  version:2,code,expiresAt,publicKeySha256:publicKey,name:"David's Mac mini",
  addresses:['https://192.168.68.123:9077','https://davids-mac-mini.local:9077','https://100.101.102.103:9077'],
 });
 const link={version:2,addresses:['https://[fd7a:115c:a1e0::1]:9077','https://mac','https://10.0.0.5'],code,expiresAt,publicKeySha256:publicKey,name:"David's Mac (2) ~ *"};
 const text=formatPairingLink(link);
 assert.ok(isPairingLink(text));
 assert.deepEqual(parsePairingLink(text),link);
 // Matches URLSearchParams form encoding, so either side can build it.
 const q=new URLSearchParams([['v','2'],['c',code],['e',String(expiresAt)],['k',publicKey],...link.addresses.map(a=>['a',a]),['n',link.name]]);
 assert.equal(text,`scantomake://pair?${q}`);
});

test('unknown keys are ignored in v1 and v2; a repeated single key is not',()=>{
 assert.equal(parsePairingLink(legacy('https://mac.tail1234.ts.net')+'&name=Mac&x').code,code);
 assert.equal(parsePairingLink(v2('&future=1&b=2')).code,code);
 for(const key of ['c','e','f','v'])invalid(()=>parsePairingLink(legacy('https://192.168.1.20:9077',certificate)+`&${key}=`+(key==='v'?'1':key==='f'?certificate:key==='e'?expiresAt:code)));
 invalid(()=>parsePairingLink(legacy('https://mac.tail1234.ts.net')+'&u=https%3A%2F%2Fmac.tail1234.ts.net'));
 for(const extra of ['&k='+publicKey,'&c='+code,'&e='+expiresAt,'&v=2','&n=A&n=B'])invalid(()=>parsePairingLink(v2(extra)));
});

test('v2 addresses are at most eight distinct pinnable https origins',()=>{
 const many=n=>Array.from({length:n},(_,i)=>`https://192.168.1.${i+1}:9077`);
 assert.equal(parsePairingLink(v2('',many(PAIRING_LINK_MAX_ADDRESSES))).addresses.length,8);
 invalid(()=>parsePairingLink(v2('',many(9))));
 invalid(()=>parsePairingLink(v2('',[])));
 invalid(()=>parsePairingLink(v2('',['https://mac.local:9077','https://MAC.local:9077'])));
 for(const bad of ['https://mac.tail1234.ts.net','https://mac.example.com','http://192.168.1.2:9077','https://192.168.1.2:9077/','https://192.168.1.2/path','https://user@192.168.1.2'])
  invalid(()=>parsePairingLink(v2('',[bad])));
 for(const extra of ['&n=','&n='+'x'.repeat(64),'&n=a%0Ab'])invalid(()=>parsePairingLink(v2(extra)));
 invalid(()=>parsePairingLink(v2().replace(publicKey,certificate.toUpperCase())));
 invalid(()=>parsePairingLink(v2().replace(`&k=${publicKey}`,'')));
 invalid(()=>parsePairingLink(v2().replace(`&c=${code}`,'')));
});

test('later versions are unsupported, not invalid; expiry applies only when now is given',()=>{
 for(const v of ['3','12'])code_(()=>parsePairingLink(v2().replace('v=2','v='+v)),'unsupported-invitation');
 for(const v of ['0','x','-1','2.0',''])invalid(()=>parsePairingLink(v2().replace('v=2','v='+v)));
 invalid(()=>parsePairingLink(v2().replace('v=2&','')));
 code_(()=>parsePairingLink(v2(),expiresAt),'expired-invitation');
 code_(()=>parsePairingLink(legacy('https://mac.tail1234.ts.net'),expiresAt+1),'expired-invitation');
 assert.equal(parsePairingLink(v2(),expiresAt-1).version,2);
 for(const e of ['soon','','+','-1','0','0x10','1e5',' 1'])invalid(()=>parsePairingLink(v2().replace(`e=${expiresAt}`,'e='+encodeURIComponent(e))));
 invalid(()=>parsePairingLink(legacy('https://mac.tail1234.ts.net').replace(`e=${expiresAt}`,'e=')));
 invalid(()=>formatPairingLink({version:2,addresses:['https://192.168.1.2:9077'],code,expiresAt:0,publicKeySha256:publicKey}));
 invalid(()=>parsePairingLink('scantomake://pair?v=2&c=%E0%A4%A'));
});

test('the formatter refuses what the parser would refuse',()=>{
 const good={version:2,addresses:['https://192.168.1.2:9077'],code,expiresAt,publicKeySha256:publicKey};
 for(const bad of [{...good,addresses:[]},{...good,addresses:['https://mac.tail1234.ts.net']},{...good,publicKeySha256:'x'},{...good,code:'short'},
  {...good,name:''},{version:1,baseUrl:'https://192.168.1.2:9077',code,expiresAt}])invalid(()=>formatPairingLink(bad));
});

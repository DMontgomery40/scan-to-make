import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ObjectStore} from '../dist/objects/store.js';
import {ObjectService} from '../dist/objects/service.js';
import {publicObject} from '../dist/objects/http.js';

async function setup(t) {
 const root=await mkdtemp(join(tmpdir(),'starters-')),store=new ObjectStore(root);
 const service=new ObjectService({store,claudePath:'/unused',handoff:{backend:'bambu-printer-mcp',process:{command:'/unused'}}});
 t.after(async()=>{await service.close();await rm(root,{recursive:true,force:true});});
 return {store,service};
}
test('the card starts clean from curated assets, never from an existing personal project',async t=>{
 const {store,service}=await setup(t);
 const personal=await store.create('Private back-and-forth');
 await store.update(personal.id,o=>({...o,messages:[{id:'private',text:'Do not ship me',atMs:1,photos:[]}],printerDestinationId:'my-printer'}));
 const before=await readFile(join(store.dir(personal.id),'object.json'));
 const card=await service.addStarter('caliper-card');
 assert.equal(card.title,'Counterpart caliper card');assert.equal(card.state,'ready');
 assert.deepEqual(card.messages,[]);assert.deepEqual(card.passes,[]);assert.deepEqual(card.photos,[]);
 assert.equal(card.print,undefined);assert.equal(card.printerDestinationId,undefined);assert.equal(card.plateProgress,undefined);
 assert.equal(card.files.receipts.length,1);assert.equal(publicObject(card).plates.length,1);
 assert.ok(card.current.renders.length,'the supplied 3MF has its own preview');
 assert.deepEqual(await readFile(join(store.dir(personal.id),'object.json')),before);
 assert.equal((await service.addStarter('caliper-card')).id,card.id);
});
test('MakerWorld starters have exact original source requests with no inherited activity',async t=>{
 const {service}=await setup(t);
 for(const id of ['scan-platform','long-vernier-caliper']) {
  const o=await service.addStarter(id);
  assert.equal(o.state,'needs-closeup');assert.equal(o.ask.type,'file');assert.equal(o.ask.url,o.credit.url);
  assert.equal(o.current,undefined,'do not pretend missing originals are ready');
  assert.deepEqual(o.messages,[]);assert.deepEqual(o.passes,[]);assert.equal(o.print,undefined);
  assert.match(o.credit.designer,/Kass|3D Print Masters Hub/);
  assert.match(o.instructions,id==='scan-platform'?/six plates/:/DEPTH GAUGE/);
 }
 await assert.rejects(service.addStarter('../caliper-card'),/starter/i);
});
test('concurrent starter taps return one project; a deleted starter can be added fresh',async t=>{
 const {service}=await setup(t);
 const [a,b]=await Promise.all([service.addStarter('caliper-card'),service.addStarter('caliper-card')]);
 assert.equal(a.id,b.id);assert.equal((await service.list()).length,1);
 await service.delete(a.id);
 const fresh=await service.addStarter('caliper-card');assert.notEqual(fresh.id,a.id);assert.equal(fresh.print,undefined);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { aggregate, sync, asPublicHTTPS, upstreamAssetURL } from '../scripts/sync-unified.mjs';

const base = resolve(new URL('..', import.meta.url).pathname);
const sha = 'a'.repeat(64);
function mod(id, version='1.0.0') {
  return { moduleId:id, moduleFamilyId:`family-${id}`, moduleIdentity:`Test-${id}`,
    moduleIdentityNumber:1,contentType:'video', version,
    sha256:sha, packageUrl:`https://raw.githubusercontent.com/kas021/Synthetiq-Modules/main/modules/${id}.zip` };
}
const upstream = [
  ['kinetiq', {modules:[mod('mine')] }],
  ['synthetiq-player', {modules:[mod('shared','1.0.0'),mod('unique-official')]}],
  ['synthetiq-player-testing', {modules:[mod('shared','9.9.9'),mod('test-unique')]}],
  ['synthetiq-player-fr-testing', {modules:[mod('franime')]}],
  ['synthetiq-manga',{modules:[{id:'manga',name:'Manga',contentType:'pageImages',manifest:{path:'modules/manga/manifest.json',sha256:sha}}]}],
  ['aroki',{connectors:[{id:'shared',name:'Aroki unrelated',manifest:{path:'connectors/shared/connector.json',sha256:sha}}]}],
  ['aroki-testing',{connectors:[{id:'other',name:'Other',manifest:{path:'connectors/other/connector.json',sha256:sha}}]}],
  ['anygo',{sources:[{id:'any',name:'Any',url:'https://raw.githubusercontent.com/kas021/AnyGo-Sources/main/sources/any.json'}]}]
];

test('Eight catalogs federate; only ZIPs go to Kinetiq repository.json, official beats test beta', async () => {
  const conf=JSON.parse(await readFile(join(base,'catalog/upstreams.json'),'utf8'));
  const data=Object.fromEntries(upstream);
  const merged=aggregate(conf,data);
  assert.equal(merged.catalogue.sourceCount,8);
  assert.equal(merged.catalogue.entryCount,10);
  assert.equal(merged.repository.modules.length,5);
  assert.equal(merged.repository.modules.find(x=>x.moduleId==='shared').version,'1.0.0');
  assert.equal(merged.catalogue.entries.filter(x=>x.key==='aroki:shared').length,1);
  assert.equal(merged.catalogue.entries.filter(x=>x.selectedForKinetiq).length,5);
  assert.equal(merged.diagnostics.duplicateZipIDs.length,1);
  assert.ok(merged.catalogue.entries.find(x=>x.key==='synthetiq-manga:manga').manifestURL);
});

test('Missing/unsafe packages remain searchable metadata but never installable', async () => {
  const conf=JSON.parse(await readFile(join(base,'catalog/upstreams.json'),'utf8'));
  const data=Object.fromEntries(upstream);
  data.kinetiq = { modules: [mod('mine')] };
  data['synthetiq-player']={modules:[{...mod('poison'),sha256:'not-a-sha'},{...mod('http'),packageUrl:'http://192.168.1.1/a.zip'}]};
  const o=aggregate(conf,data);
  assert.ok(o.diagnostics.skippedZipEntries.length >= 2);
  assert.equal(o.repository.modules.some(x=>['poison','http'].includes(x.moduleId)),false);
  assert.equal(asPublicHTTPS('https://127.0.0.1/x.zip'),null);
  assert.equal(upstreamAssetURL(conf.repositories[5],'../bad.json'),null);
});

test('Fail closed: missing upstream cannot overwrite existing repository output', async () => {
  const dir = await mkdtemp(join(tmpdir(),'kinetiq-unified-test-'));
  try {
    await mkdir(join(dir,'catalog'),{recursive:true});
    await mkdir(join(dir,'fixtures'));
    await writeFile(join(dir,'catalog/upstreams.json'),await readFile(join(base,'catalog/upstreams.json')));
    await writeFile(join(dir,'catalog/local-modules.json'),JSON.stringify(upstream[0][1]));
    await writeFile(join(dir,'repository.json'),'KEEP EXISTING CONTENT\n');
    for (const [key, data] of upstream) if(key!=='kinetiq' && key!=='anygo') await writeFile(join(dir,'fixtures',`${key}.json`),JSON.stringify(data));
    await assert.rejects(sync({root:dir,fixtureDir:join(dir,'fixtures')}), /ENOENT/);
    assert.equal(await readFile(join(dir,'repository.json'),'utf8'),'KEEP EXISTING CONTENT\n');
    await writeFile(join(dir,'fixtures','anygo.json'),JSON.stringify(upstream[7][1]));
    const out=await sync({root:dir,fixtureDir:join(dir,'fixtures')});
    assert.equal(out.entries,10);
    assert.equal(out.installedCandidates,5);
    assert.equal(JSON.parse(await readFile(join(dir,'repository.json'))).modules.length,5);
    const hash=JSON.parse(await readFile(join(dir,'catalog/unified.json'))).sourceSnapshotSHA256;
    await sync({root:dir,fixtureDir:join(dir,'fixtures')});
    assert.equal(JSON.parse(await readFile(join(dir,'catalog/unified.json'))).sourceSnapshotSHA256,hash);
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('Reject duplicate module IDs within same publisher source', async () => {
  const conf=JSON.parse(await readFile(join(base,'catalog/upstreams.json'),'utf8'));
  const data=Object.fromEntries(upstream);
  data['synthetiq-player'].modules.push(mod('shared','3.0.0'));
  assert.throws(()=>aggregate(conf,data), /Duplicate ID/);
});

test('Checked-in bootstrap repository preserves 3 local modules plus 40 upstream ZIP candidates', async () => {
  const bootstrap=JSON.parse(await readFile(join(base,'repository.json'),'utf8'));
  const owned=JSON.parse(await readFile(join(base,'catalog/local-modules.json'),'utf8'));
  assert.equal(bootstrap.repositoryId, owned.repositoryId);
  assert.equal(bootstrap.modules.length,43);
  assert.equal(owned.modules.length,3);
  for (const m of owned.modules) {
    const present=bootstrap.modules.find(x=>x.moduleId===m.moduleId);
    assert.deepEqual(present,m);
  }
  assert.equal(new Set(bootstrap.modules.map(x=>x.moduleId)).size,43);
  assert.ok(bootstrap.modules.every(x=>x.contentType==='video' && /^[a-f0-9]{64}$/.test(x.sha256) && asPublicHTTPS(x.packageUrl)));
});
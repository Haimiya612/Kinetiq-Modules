#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { asPublicHTTPS } from './sync-unified.mjs';
const root = resolve(new URL('..', import.meta.url).pathname);
const repo = JSON.parse(await readFile(resolve(root,'repository.json'), 'utf8'));
const catalog = JSON.parse(await readFile(resolve(root,'catalog/unified.json'), 'utf8'));
const config = JSON.parse(await readFile(resolve(root,'catalog/upstreams.json'), 'utf8'));
const ids = new Set();
if (repo.schemaVersion !== 1 || !Array.isArray(repo.modules)) throw Error('Invalid Kinetiq repository contract');
if (catalog.sourceCount !== 8 || config.repositories.length !== 8) throw Error('Missing an upstream');
if (catalog.entryCount !== catalog.entries.length) throw Error('Catalogue count mismatch');
for (const m of repo.modules) {
  if (!m.moduleId || ids.has(m.moduleId)) throw Error('Duplicate/empty ID: '+m.moduleId);
  ids.add(m.moduleId);
  if (m.contentType !== 'video' || !m.version || !m.moduleIdentity || !m.moduleFamilyId || !(m.moduleIdentityNumber > 0)) throw Error('Invalid identity: '+m.moduleId);
  if (!asPublicHTTPS(m.packageUrl) || !/^[a-f0-9]{64}$/i.test(m.sha256)) throw Error('Unsafe package: '+m.moduleId);
  if (!catalog.entries.some(x=>x.id===m.moduleId && x.selectedForKinetiq && x.packageURL===m.packageUrl && x.upstreamSHA256===m.sha256)) throw Error('Selected entry missing: '+m.moduleId);
}
if (catalog.entries.filter(e=>e.selectedForKinetiq).length !== repo.modules.length) throw Error('Selected catalogue mismatch');
if (new Set(catalog.entries.map(x=>x.key)).size !== catalog.entries.length) throw Error('Duplicate federated keys');
for (const e of catalog.entries) {
  if (e.installability === 'metadata-only' && e.selectedForKinetiq) throw Error('Noninstallable selected: '+e.key);
}
console.log(`PASS: ${repo.modules.length} ZIP candidates, ${catalog.entries.length} catalogued from 8 upstreams; IDs unique and SHA-256 present.`);
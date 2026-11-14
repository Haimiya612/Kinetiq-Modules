#!/usr/bin/env node
/**
 * Kinetiq Unified Modules · Batch 07A
 * Federates 8 PUBLIC catalogues. References upstream packages in the existing
 * Kinetiq repository.json contract. NEVER rewrites a ZIP, strips a signature,
 * executes upstream JS, or presents incompatible formats as installable.
 *
 * Usage: node scripts/sync-unified.mjs [--root DIR] [--fixture-dir DIR] [--dry-run]
 * Node 22+, zero third-party dependencies.
 */
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { resolve, dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HASH = /^[0-9a-f]{64}$/i;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const MAX_INDEX_BYTES = 8_000_000;
const MAX_MODULES_PER_REPO = 2_000;
const OUTPUT_REPO_ID = 'kinetiq-custom-modules'; // Keep established trusted publisher identity.

export function asPublicHTTPS(input) {
  if (typeof input !== 'string' || input.length > 2048) return null;
  try {
    const url = new URL(input);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !url.hostname) return null;
    if (url.hostname === 'localhost' || url.hostname.endsWith('.local') || url.hostname.endsWith('.internal')) return null;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(url.hostname) || url.hostname.includes(':')) return null;
    return url.toString();
  } catch { return null; }
}

export function upstreamIndexURL(repo) {
  if (!REPOSITORY.test(repo.repository)) throw new Error(`Invalid upstream slug: ${repo.repository}`);
  const p = repo.indexPath;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_./-]*\.json$/.test(p) || p.split('/').includes('..')) {
    throw new Error(`Unsafe index path: ${p}`);
  }
  return `https://raw.githubusercontent.com/${repo.repository}/main/${p}`;
}

export function upstreamAssetURL(repo, path) {
  if (typeof path !== 'string' || !path || path.startsWith('/') || path.includes('\\') || path.split('/').includes('..') || path.includes('?') || path.includes('#')) return null;
  const normalized = posix.normalize(path);
  return asPublicHTTPS(`https://raw.githubusercontent.com/${repo.repository}/main/${normalized}`);
}

function sanitizedText(v, limit = 800) {
  return typeof v === 'string' ? v.trim().slice(0, limit) : null;
}
function sha(value) { return typeof value === 'string' && HASH.test(value) ? value.toLowerCase() : null; }
function digest(value) { return createHash('sha256').update(value).digest('hex'); }
function canonicalJSON(value) { return JSON.stringify(value, null, 2) + '\n'; }

function collectRows(repo, index) {
  if (!index || typeof index !== 'object' || Array.isArray(index)) throw new Error(`Invalid JSON object: ${repo.key}`);
  const rows = repo.kind === 'connectorManifest' ? index.connectors
    : repo.kind === 'anygoSource' ? index.sources : index.modules;
  if (!Array.isArray(rows) || rows.length > MAX_MODULES_PER_REPO) throw new Error(`Bad module array: ${repo.key}`);
  const seen = new Set();
  return rows.map((raw, i) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`Nonobject ${repo.key}[${i}]`);
    const moduleId = raw.moduleId ?? raw.id;
    if (typeof moduleId !== 'string' || !ID.test(moduleId)) throw new Error(`Invalid id in ${repo.key}[${i}]`);
    if (seen.has(moduleId)) throw new Error(`Duplicate ID within ${repo.key}: ${moduleId}`);
    seen.add(moduleId);
    return { raw, moduleId };
  });
}

export function aggregate(config, indices) {
  const repos = config.repositories;
  if (!Array.isArray(repos) || repos.length !== 8 || new Set(repos.map(r => r.key)).size !== 8) {
    throw new Error('This batch requires eight unique upstream repositories.');
  }
  const selectedByID = new Map();
  const entries = [];
  const invalidPackages = [];
  const sourceTotals = [];
  const conflicts = new Map();

  for (const repo of repos) {
    const index = indices[repo.key];
    const rows = collectRows(repo, index);
    sourceTotals.push({ key: repo.key, repository: repo.repository, format: repo.format, entries: rows.length });
    for (const { raw, moduleId } of rows) {
      const metadataURL = repo.scope === 'local' ? 'catalog/local-modules.json' : upstreamIndexURL(repo);
      const isZip = repo.kind === 'videoZip';
      const status = sanitizedText(raw.status, 60) ?? 'unspecified';
      const contentType = sanitizedText(raw.contentType, 100) ?? (repo.kind === 'anygoSource' ? 'unknown' : 'video');
      const pkgURL = asPublicHTTPS(raw.packageUrl);
      const pkgHash = sha(raw.sha256);
      const validZip = isZip && contentType.toLowerCase() === 'video' && pkgURL !== null && pkgHash !== null;
      const rawManifestPath = raw.manifest?.path;
      const manifestURL = typeof rawManifestPath === 'string' ? upstreamAssetURL(repo, rawManifestPath) : null;
      const standaloneURL = repo.kind === 'anygoSource' ? asPublicHTTPS(raw.url) : null;
      const entry = {
        key: `${repo.key}:${moduleId}`,
        id: moduleId,
        name: sanitizedText(raw.name ?? raw.moduleIdentity ?? raw.moduleName ?? moduleId, 180) || moduleId,
        version: sanitizedText(raw.version, 100),
        contentType,
        status,
        releaseTrack: sanitizedText(raw.releaseTrack, 30),
        format: repo.format,
        upstream: repo.repository,
        upstreamIndex: metadataURL,
        manifestURL,
        standaloneURL,
        upstreamMinAppVersion: sanitizedText(raw.minAppVersion ?? raw.minimumAppVersion, 40),
        upstreamSHA256: isZip ? pkgHash : sha(raw.manifest?.sha256),
        packageURL: isZip ? pkgURL : null,
        releaseNotes: sanitizedText(raw.releaseNotes ?? raw.description ?? raw.changelog?.[0], 1200),
        installability: validZip ? 'candidate-zip' : 'metadata-only',
        selectedForKinetiq: false,
        limitations: validZip
          ? 'Kinetiq V3 package contract and live playback must still be verified; metadata is not certification.'
          : 'This source format is not executable by the current Kinetiq video ZIP runtime.'
      };
      entries.push(entry);
      if (isZip && !validZip) invalidPackages.push({ key: entry.key, reason: 'Missing video contentType, public HTTPS packageUrl or valid SHA-256' });
      if (!validZip || status.toLowerCase() === 'retired') continue;
      const existing = selectedByID.get(moduleId);
      const rank = Number(repo.priority);
      const candidate = { repo, raw, entry, rank };
      if (!existing || rank < existing.rank) {
        selectedByID.set(moduleId, candidate);
      }
      if (!conflicts.has(moduleId)) conflicts.set(moduleId, []);
      conflicts.get(moduleId).push(candidate);
    }
  }

  const modules = [];
  for (const [moduleId, selected] of [...selectedByID].sort((a, b) => a[0].localeCompare(b[0], 'en'))) {
    const { raw, entry, repo } = selected;
    entry.selectedForKinetiq = true;
    const item = {
      moduleId,
      moduleFamilyId: sanitizedText(raw.moduleFamilyId, 128),
      moduleIdentity: sanitizedText(raw.moduleIdentity, 180),
      moduleIdentityNumber: Number.isSafeInteger(raw.moduleIdentityNumber) && raw.moduleIdentityNumber > 0 ? raw.moduleIdentityNumber : null,
      contentType: 'video',
      version: sanitizedText(raw.version, 80),
      packageUrl: entry.packageURL,
      sha256: entry.upstreamSHA256
    };
    // Preserve Kinetiq's existing identity validation. If a publisher supplies
    // incomplete identity data, the module is retained in the catalog but NOT
    // included in the native install list (no fake identity is invented).
    if (!item.moduleFamilyId || !item.moduleIdentity || !item.moduleIdentityNumber || !item.version) {
      entry.selectedForKinetiq = false;
      entry.installability = 'metadata-only';
      entry.limitations = 'Missing required stable publisher identity fields';
      invalidPackages.push({ key: entry.key, reason: entry.limitations });
      continue;
    }
    const presentation = {};
    for (const k of ['category', 'purpose', 'language', 'iconUrl']) {
      if (typeof raw.presentation?.[k] === 'string') presentation[k] = raw.presentation[k].slice(0, 500);
    }
    if (Array.isArray(raw.presentation?.languages)) presentation.languages = raw.presentation.languages.filter(x => typeof x === 'string').slice(0, 20);
    if (typeof raw.presentation?.recommended === 'boolean') presentation.recommended = raw.presentation.recommended;
    if (repo.installPolicy === 'unique-only' && !presentation.category) presentation.category = 'Testing';
    if (Object.keys(presentation).length) item.presentation = presentation;
    if (Number.isSafeInteger(raw.publishedAtMs)) item.publishedAtMs = raw.publishedAtMs;
    if (Array.isArray(raw.changelog)) item.changelog = raw.changelog.filter(x => typeof x === 'string').slice(0, 6).map(x => x.slice(0, 1300));
    // minAppVersion from upstream refers to another APP. It must NOT be copied
    // into a Kinetiq-specific version gate; retained above in unified.json.
    modules.push(item);
  }

  const duplicates = [...conflicts].filter(([, group]) => group.length > 1).map(([moduleId, group]) => ({
    moduleId,
    selected: selectedByID.get(moduleId).entry.key,
    alternatives: group.map(c => ({ key: c.entry.key, version: c.entry.version, sha256: c.entry.upstreamSHA256 }))
  })).sort((a, b) => a.moduleId.localeCompare(b.moduleId, 'en'));
  const total = entries.length;
  const repoOut = { schemaVersion: 1, repositoryId: OUTPUT_REPO_ID, name: 'Kinetiq Unified Modules', enabled: true, modules };
  const catalogue = {
    schemaVersion: 1,
    repositoryId: OUTPUT_REPO_ID,
    name: 'Kinetiq Unified Catalogue',
    sourceCount: repos.length,
    entryCount: total,
    nativeZipCandidates: modules.length,
    warning: 'A catalogue entry is not proof of package compatibility, live playback, redistribution rights or source reliability.',
    sources: sourceTotals,
    entries
  };
  const diagnostics = { schemaVersion: 1, duplicateZipIDs: duplicates, skippedZipEntries: invalidPackages };
  return { repository: repoOut, catalogue, diagnostics };
}

async function atomicWrite(path, data) {
  await mkdir(dirname(path), { recursive: true });
  const temp = path + '.tmp';
  await writeFile(temp, data, 'utf8');
  await rename(temp, path);
}

export async function sync({ root = scriptRoot, fixtureDir = null, dryRun = false, fetchImpl = globalThis.fetch } = {}) {
  const config = JSON.parse(await readFile(join(root, 'catalog', 'upstreams.json'), 'utf8'));
  const indices = {};
  const hashParts = [];
  // Fail closed: if ANY upstream fails, no new merged output is committed.
  const data = await Promise.all(config.repositories.map(async repo => {
    let input;
    if (repo.scope === 'local') {
      input = await readFile(join(root, repo.indexPath), 'utf8');
    } else if (fixtureDir) {
      input = await readFile(join(fixtureDir, `${repo.key}.json`), 'utf8');
    } else {
      const url = upstreamIndexURL(repo);
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(25_000), headers: { 'Accept': 'application/json' }, redirect: 'follow' });
      if (!response.ok) throw new Error(`Upstream ${repo.key}: HTTP ${response.status}`);
      const declared = Number(response.headers.get('content-length'));
      if (declared > MAX_INDEX_BYTES) throw new Error(`Upstream ${repo.key}: index too large`);
      input = await response.text();
    }
    if (Buffer.byteLength(input, 'utf8') > MAX_INDEX_BYTES) throw new Error(`Upstream ${repo.key}: oversized JSON`);
    return { repo, input };
  }));
  for (const { repo, input } of data) {
    indices[repo.key] = JSON.parse(input);
    hashParts.push(`${repo.key}:${digest(canonicalJSON(indices[repo.key]))}`);
  }
  const out = aggregate(config, indices);
  out.catalogue.sourceSnapshotSHA256 = digest(hashParts.join('\n'));
  if (!dryRun) {
    await atomicWrite(join(root, 'repository.json'), canonicalJSON(out.repository));
    await atomicWrite(join(root, 'catalog', 'unified.json'), canonicalJSON(out.catalogue));
    await atomicWrite(join(root, 'catalog', 'diagnostics.json'), canonicalJSON(out.diagnostics));
  }
  return { entries: out.catalogue.entryCount, installedCandidates: out.repository.modules.length,
    duplicateZipIDs: out.diagnostics.duplicateZipIDs.length, rejected: out.diagnostics.skippedZipEntries.length,
    snapshot: out.catalogue.sourceSnapshotSHA256 };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const flag = key => { const i = args.indexOf(key); return i >= 0 ? args[i + 1] : null; };
  const root = flag('--root') ? resolve(flag('--root')) : scriptRoot;
  const fixtureDir = flag('--fixture-dir') ? resolve(flag('--fixture-dir')) : null;
  sync({ root, fixtureDir, dryRun: args.includes('--dry-run') }).then(
    result => console.log(JSON.stringify({ status: 'ok', ...result }, null, 2)),
    error => { console.error(`Unified sync aborted (outputs preserved): ${error.stack ?? error}`); process.exitCode = 1; }
  );
}
'use strict';

// Publication-only tool. Never loaded by SpoonMate or its protected runtime.
// A fresh live verification is mandatory before any historical release write.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const {execFileSync, spawn} = require('node:child_process');
const REPOSITORY = 'gisun5689/spoonmate';
const SITE = 'https://gisun5689.github.io/spoonmate';
const MANIFEST = 'SpoonMate_LITE_Update_Release_Manifest.json';
const HASH = /^[a-f0-9]{64}$/;
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
class GuardError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
function guard(condition, code, message) { if (!condition) throw new GuardError(code, message); }
function same(actual, expected, code, message) { guard(JSON.stringify(actual) === JSON.stringify(expected), code, message); }
function parseVersion(tag) {
  const match = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(String(tag));
  guard(match, 'TAG_INVALID', 'Require a numeric four-part SpoonMate release tag.');
  const parts = match.slice(1).map(Number);
  guard(parts.every(Number.isSafeInteger), 'TAG_INVALID', 'Release version is outside the supported numeric range.');
  return parts;
}
function compareVersion(left, right) {
  const a = parseVersion(left), b = parseVersion(right);
  for (let index = 0; index < 4; index++) if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  return 0;
}
function internalVersion(tag) {
  const parts = parseVersion(tag), build = Number(`${parts[2]}${parts[3]}`);
  guard(Number.isSafeInteger(build), 'TAG_INVALID', 'Internal version is outside the supported numeric range.');
  return `${parts[0]}.${parts[1]}.${build}`;
}
function compareInternal(a, b) {
  const left = internalVersion(a).split('.').map(Number), right = internalVersion(b).split('.').map(Number);
  for (let index = 0; index < 3; index++) if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  return 0;
}
function previousVersion(inventory, tag) {
  const candidates = inventory.filter(release => {
    try { return compareVersion(release.tag_name, tag) < 0 && compareInternal(release.tag_name, tag) < 0; } catch { return false; }
  }).map(release => release.tag_name).sort((a, b) => compareInternal(a, b) || compareVersion(a, b));
  if (candidates.length) return candidates.at(-1).slice(1);
  const parts = parseVersion(tag);
  for (let index = 3; index >= 0; index--) {
    if (parts[index] > 0) {
      parts[index]--; for (let next = index + 1; next < 4; next++) parts[next] = 0;
      const previous = `v${parts.join('.')}`;
      guard(compareInternal(previous, tag) < 0, 'PREVIOUS_VERSION_INVALID', 'Cannot derive a safe previous updater version.');
      return previous.slice(1);
    }
  }
  throw new GuardError('PREVIOUS_VERSION_INVALID', 'Cannot derive a previous updater version.');
}
const assetState = release => release.assets.map(asset => ({id: asset.id, name: asset.name, size: asset.size, digest: asset.digest ?? null, state: asset.state})).sort((a, b) => a.id - b.id);
const releaseState = release => ({id: release.id, tag_name: release.tag_name, target_commitish: release.target_commitish, name: release.name, body: release.body, prerelease: release.prerelease, immutable: release.immutable ?? false, assets: assetState(release)});
// Actions evidence can be downloaded independently of this process. Keep
// private/prepared draft metadata in memory only, and never publish raw notes
// or signed/untagged download URLs into an artifact or log.
const publicReleaseEvidence = release => ({id: release.id, tag_name: release.tag_name, draft: release.draft, prerelease: release.prerelease, immutable: release.immutable ?? false, body_sha256: sha256(String(release.body || '')), assets: assetState(release)});
const gateState = gate => ({sha: gate.sha, sha256: sha256(gate.bytes), value: gate.value});
const tagState = tags => tags.map(tag => ({name: tag.name, sha: tag.sha})).sort((a, b) => a.name.localeCompare(b.name));
function validateLiteGate(gate, tag) {
  guard(gate?.value?.schema_version === 1 && gate.value.edition === 'lite' && gate.value.channel === 'lite', 'LITE_GATE_INVALID', 'Require the established Lite update channel.');
  guard(gate.value.published === true && gate.value.release_tag === tag && gate.value.latest_display_version === tag.slice(1) && gate.value.latest_internal_version === internalVersion(tag), 'LITE_GATE_INVALID', 'The published Lite gate must match the target release.');
  guard(gate.value.release_page_url === `https://github.com/${REPOSITORY}/releases/tag/${tag}`, 'LITE_GATE_INVALID', 'Unexpected release page in the Lite gate.');
  guard(typeof gate.sha === 'string' && gate.sha && Buffer.isBuffer(gate.bytes), 'LITE_GATE_INVALID', 'Require the current repository gate object and bytes.');
}
function validateGeneralGate(gate) {
  guard(gate?.value?.published === false && typeof gate.sha === 'string' && gate.sha && Buffer.isBuffer(gate.bytes), 'GENERAL_GATE_INVALID', 'General must remain private manual distribution.');
}
function validateLatest(release, tag) {
  parseVersion(tag);
  guard(release && Number.isSafeInteger(release.id) && release.id > 0 && release.tag_name === tag && release.draft === false && release.prerelease === false, 'LATEST_INVALID', 'The target must be the current public stable release.');
  guard(Array.isArray(release.assets) && release.assets.length === 4, 'LATEST_ASSETS_INVALID', 'Exactly four matching Lite public assets are required.');
  const installer = release.assets.find(asset => asset.name === `SpoonMate_Lite_Setup_v${tag.slice(1)}_x64.exe` || asset.name === `SpoonMate_Lite_Setup_v${tag.slice(1)}_x64_UNSIGNED.exe`);
  guard(installer, 'LATEST_ASSETS_INVALID', 'A matching Lite installer is required.');
  same(release.assets.map(asset => asset.name).sort(), [installer.name, `${installer.name}.blockmap`, 'lite.yml', MANIFEST].sort(), 'LATEST_ASSETS_INVALID', 'Cross-edition, extra or duplicate release assets are forbidden.');
  guard(new Set(release.assets.map(asset => asset.id)).size === 4, 'LATEST_ASSETS_INVALID', 'Duplicate release asset identity.');
  for (const asset of release.assets) {
    const maximum = asset.name === MANIFEST ? 64 * 1024 : asset.name === 'lite.yml' ? 1024 * 1024 : asset.name.endsWith('.blockmap') ? 32 * 1024 * 1024 : 512 * 1024 * 1024;
    guard(Number.isSafeInteger(asset.id) && asset.id > 0 && Number.isSafeInteger(asset.size) && asset.size > 0 && asset.size <= maximum && asset.state === 'uploaded' && /^sha256:[a-f0-9]{64}$/.test(asset.digest || ''), 'LATEST_ASSETS_INVALID', 'Require uploaded Lite assets with stable identity, bounded size and SHA-256.');
    guard(asset.browser_download_url === downloadUrl(tag, asset.name), 'LATEST_ASSETS_INVALID', 'Unexpected latest asset URL.');
  }
  return installer;
}
function selectPlan(inventory, latest, tag) {
  guard(Array.isArray(inventory) && inventory.filter(release => release.id === latest.id).length === 1 && new Set(inventory.map(release => release.id)).size === inventory.length, 'INVENTORY_INVALID', 'Release inventory is incomplete or ambiguous.');
  // Draft history can still be installed on a user's PC. A display-version
  // increase is not sufficient when the established concatenated NSIS version
  // would decrease (for example 2.0.15.107 -> 2.0.16.1).
  for (const release of inventory) {
    let valid = true; try { parseVersion(release.tag_name); } catch { valid = false; }
    if (valid && compareVersion(release.tag_name, tag) < 0)
      guard(compareInternal(release.tag_name, tag) < 0, 'UPDATER_VERSION_NON_MONOTONIC', 'The target internal updater version must exceed all older installed release versions, including drafts.');
  }
  const targets = [];
  for (const release of inventory) {
    if (release.id === latest.id) continue;
    if (release.draft === true) continue;
    guard(release.draft === false, 'INVENTORY_INVALID', 'Unknown release publication state.');
    parseVersion(release.tag_name);
    guard(compareVersion(release.tag_name, tag) < 0, 'NEWER_RELEASE_PRESENT', 'An equal or newer public release prevents historical cleanup.');
    guard(release.prerelease === false, 'UNEXPECTED_PRERELEASE', 'A public prerelease requires an explicit operator review.');
    guard(release.immutable !== true, 'IMMUTABLE_RELEASE', 'An immutable historical release requires an explicit operator review.');
    guard(Number.isSafeInteger(release.id) && release.id > 0 && Array.isArray(release.assets), 'INVENTORY_INVALID', 'Invalid historical release identity.');
    targets.push(release);
  }
  return targets.sort((a, b) => compareVersion(b.tag_name, a.tag_name));
}
function downloadUrl(tag, name) { return `https://github.com/${REPOSITORY}/releases/download/${tag}/${encodeURIComponent(name)}`; }
function safeError(error) {
  return error instanceof GuardError ? {code: error.code, message: error.message} : {code: 'OPERATION_FAILED', message: 'A publication check or GitHub operation failed. No automatic rollback or republish was attempted.'};
}
async function preserved(adapter, baseline, withTags = false) {
  const latest = await adapter.getLatest(); validateLatest(latest, baseline.tag);
  same(releaseState(latest), releaseState(baseline.latest), 'LATEST_CHANGED', 'Latest release contents changed during cleanup.');
  same(latest.assets.map(asset => asset.browser_download_url).sort(), baseline.latest.assets.map(asset => asset.browser_download_url).sort(), 'LATEST_CHANGED', 'Latest download URLs changed during cleanup.');
  same(gateState(await adapter.getGate('lite')), gateState(baseline.lite), 'LITE_GATE_CHANGED', 'Lite gate changed during cleanup.');
  same(gateState(await adapter.getGate('general')), gateState(baseline.general), 'GENERAL_GATE_CHANGED', 'General gate changed during cleanup.');
  if (withTags) {
    same(tagState(await adapter.listTags()), baseline.tags, 'TAGS_CHANGED', 'Git tag refs changed during cleanup.');
    const repo = await adapter.getRepository();
    guard(repo.full_name === REPOSITORY && repo.private === false && repo.visibility === 'public', 'REPOSITORY_CHANGED', 'Repository visibility changed during cleanup.');
  }
}
async function publicGateReady(adapter, baseline, seconds) {
  const until = adapter.now() + seconds * 1000;
  for (;;) {
    const response = await adapter.getPublicGate('lite');
    if (response.status === 200 && Buffer.isBuffer(response.bytes) && sha256(response.bytes) === sha256(baseline.lite.bytes)) return;
    guard(adapter.now() < until, 'PUBLIC_GATE_NOT_READY', 'Public Pages Lite gate has not reached the verified target.');
    await adapter.sleep(Math.min(2000, until - adapter.now()));
  }
}
async function verifyPublic(adapter, baseline, waitSeconds) {
  await publicGateReady(adapter, baseline, waitSeconds);
  const publicGeneral = await adapter.getPublicGate('general');
  guard(publicGeneral.status === 200 && sha256(publicGeneral.bytes) === sha256(baseline.general.bytes), 'PUBLIC_GENERAL_GATE_CHANGED', 'Public General gate must remain byte-identical.');
  const publicLatest = await adapter.getPublicLatest(); validateLatest(publicLatest, baseline.tag);
  same(releaseState(publicLatest), releaseState(baseline.latest), 'PUBLIC_LATEST_CHANGED', 'Public latest release differs from the authenticated target.');
  const manifestAsset = baseline.latest.assets.find(asset => asset.name === MANIFEST);
  const downloadedManifest = await adapter.readPublicAsset(baseline.tag, manifestAsset, true);
  guard(downloadedManifest.status === 200 && downloadedManifest.size === manifestAsset.size && `sha256:${downloadedManifest.sha256}` === manifestAsset.digest && Buffer.isBuffer(downloadedManifest.bytes), 'PUBLIC_ASSET_INVALID', 'Published Lite manifest bytes do not match the approved asset.');
  let manifest; try { manifest = JSON.parse(downloadedManifest.bytes.toString('utf8')); } catch { throw new GuardError('MANIFEST_INVALID', 'Published Lite manifest is not valid JSON.'); }
  guard(manifest?.schema_version === 1 && manifest.edition === 'lite' && manifest.channel === 'lite' && manifest.repository === REPOSITORY && manifest.display_version === baseline.tag.slice(1) && manifest.internal_version === internalVersion(baseline.tag) && Array.isArray(manifest.files) && manifest.files.length === 3, 'MANIFEST_INVALID', 'Published Lite manifest does not describe the exact target.');
  same(manifest.files.map(file => file.file_name).sort(), baseline.latest.assets.filter(asset => asset.name !== MANIFEST).map(asset => asset.name).sort(), 'MANIFEST_INVALID', 'Manifest files do not match the three Lite payload files.');
  const assets = [{name: MANIFEST, size: downloadedManifest.size, sha256: downloadedManifest.sha256}];
  for (const file of manifest.files) {
    const remote = baseline.latest.assets.find(asset => asset.name === file.file_name);
    guard(remote && Number.isSafeInteger(file.size) && file.size === remote.size && HASH.test(file.sha256 || '') && remote.digest === `sha256:${file.sha256}`, 'MANIFEST_INVALID', 'Manifest file hash or size differs from the release asset.');
    const downloaded = await adapter.readPublicAsset(baseline.tag, remote, false);
    guard(downloaded.status === 200 && downloaded.size === file.size && downloaded.sha256 === file.sha256, 'PUBLIC_ASSET_INVALID', 'A published Lite payload failed full-byte download verification.');
    assets.push({name: file.file_name, size: downloaded.size, sha256: downloaded.sha256});
  }
  const previousDisplay = previousVersion(baseline.inventory, baseline.tag);
  const installer = validateLatest(baseline.latest, baseline.tag);
  const updater = await adapter.probeUpdater({previousDisplay, targetInternal: internalVersion(baseline.tag), installerName: installer.name, installerSize: installer.size});
  guard(updater?.success === true && updater.detected_internal_version === internalVersion(baseline.tag) && updater.download_performed === false && updater.install_performed === false && updater.production_user_data_accessed === false, 'UPDATER_INVALID', 'The real isolated updater did not confirm the exact public target.');
  await preserved(adapter, baseline, true);
  return {assets, updater, fresh_live_verification: true};
}
async function verifyFinal(adapter, baseline, targets) {
  const current = await adapter.listReleases();
  same(current.filter(release => !release.draft).map(release => release.id).sort((a, b) => a - b), [baseline.latest.id], 'PUBLIC_RELEASE_COUNT_INVALID', 'Only the verified latest release may remain public.');
  for (const original of baseline.inventory) {
    const found = current.find(release => release.id === original.id);
    guard(found, 'RELEASE_MISSING', 'A historical release was removed during cleanup.');
    same(releaseState(found), releaseState(original), 'ASSET_CHANGED', 'Release metadata or asset bytes changed during cleanup.');
    if (original.id !== baseline.latest.id) guard(found.draft === true, 'OLD_RELEASE_PUBLIC', 'An older release is still public.');
  }
  await preserved(adapter, baseline, true);
  const publicList = await adapter.getPublicReleases();
  guard(publicList.length === 1 && publicList[0].id === baseline.latest.id, 'PUBLIC_RELEASE_COUNT_INVALID', 'Anonymous release listing must contain only the verified target.');
  validateLatest(publicList[0], baseline.tag);
  for (const asset of baseline.latest.assets) guard(await adapter.publicAssetStatus(baseline.tag, asset.name) === 200, 'LATEST_DOWNLOAD_UNAVAILABLE', 'A latest release download is no longer public.');
  const old = targets[0] || baseline.inventory.find(release => release.id !== baseline.latest.id && release.assets.some(asset => /\.exe$/i.test(asset.name)));
  if (old) {
    guard(await adapter.publicReleaseStatus(old.id) === 404, 'OLD_RELEASE_ACCESSIBLE', 'An older release is still anonymously accessible.');
    const installer = old.assets.find(asset => /\.exe$/i.test(asset.name));
    if (installer) guard(await adapter.publicAssetStatus(old.tag_name, installer.name) === 404, 'OLD_ASSET_ACCESSIBLE', 'An older installer is still anonymously accessible.');
  }
  const publicLite = await adapter.getPublicGate('lite'), publicGeneral = await adapter.getPublicGate('general');
  guard(publicLite.status === 200 && sha256(publicLite.bytes) === sha256(baseline.lite.bytes), 'PUBLIC_GATE_CHANGED', 'Public Lite gate changed after cleanup.');
  guard(publicGeneral.status === 200 && sha256(publicGeneral.bytes) === sha256(baseline.general.bytes), 'PUBLIC_GENERAL_GATE_CHANGED', 'Public General gate changed after cleanup.');
}
async function runRetention(options, adapter) {
  const report = {schema_version: 1, repository: REPOSITORY, started_at: new Date(adapter.now()).toISOString(), apply: options.apply === true, verified_current: options.verifyCurrent === true, hidden: [], deleted_assets: 0, deleted_releases: 0, deleted_tags: 0, user_app_touched: false};
  const record = async (name, value) => { if (adapter.writeEvidence) await adapter.writeEvidence(name, value); };
  let phase = 'preflight';
  try {
    const seconds = options.waitSeconds ?? 0;
    guard(Number.isInteger(seconds) && seconds >= 0 && seconds <= 900, 'OPTIONS_INVALID', 'Pages wait must be between 0 and 900 seconds.');
    const repo = await adapter.getRepository();
    // Installation/GITHUB_TOKEN responses can omit user-style permissions.
    // Never infer or grant access from this optional metadata: GitHub enforces
    // the configured token's real ACL on every PATCH below.
    guard(repo.full_name === REPOSITORY && repo.private === false && repo.visibility === 'public', 'REPOSITORY_INVALID', 'Require the established public SpoonMate repository.');
    const lite = await adapter.getGate('lite'), general = await adapter.getGate('general');
    const tag = options.tag || lite.value?.release_tag; parseVersion(tag); validateLiteGate(lite, tag); validateGeneralGate(general);
    const latest = await adapter.getLatest(); validateLatest(latest, tag);
    const inventory = await adapter.listReleases(), targets = selectPlan(inventory, latest, tag);
    const baseline = {tag, latest, inventory, lite, general, tags: tagState(await adapter.listTags())};
    report.target = tag; report.target_release_id = latest.id; report.planned = targets.map(release => ({id: release.id, tag: release.tag_name, asset_count: release.assets.length}));
    await record('before', {at: report.started_at, repository: {full_name: repo.full_name, visibility: repo.visibility}, latest: publicReleaseEvidence(latest), public_inventory: inventory.filter(release => !release.draft).map(publicReleaseEvidence), existing_drafts_count: inventory.filter(release => release.draft).length, gates: {lite: gateState(lite), general: gateState(general)}, tags: baseline.tags});
    await record('plan', {target: tag, apply: report.apply, planned: report.planned});
    if (!targets.length && !options.verifyCurrent) {
      await preserved(adapter, baseline, true);
      Object.assign(report, {success: true, no_op: true, fresh_live_verification: false, reason: 'No older public release; authenticated latest and channel policy confirmed.'});
      await record('result', report); return report;
    }
    phase = 'fresh_public_verification';
    const verified = await verifyPublic(adapter, baseline, seconds);
    Object.assign(report, verified); await record('fresh-verification', verified);
    if (!report.apply) {
      Object.assign(report, {success: true, dry_run: true, no_op: targets.length === 0});
      if (!targets.length) await verifyFinal(adapter, baseline, targets);
      await record('result', report); return report;
    }
    phase = 'draft_historical_releases';
    for (const target of targets) {
      // Latest and both gates are re-read before every write. The immutable
      // target list contains strictly older IDs, never a newly published ID.
      await preserved(adapter, baseline);
      const current = await adapter.getRelease(target.id);
      same(releaseState(current), releaseState(target), 'ASSET_CHANGED', 'Historical release changed before draft conversion.');
      guard(current.id !== latest.id && compareVersion(current.tag_name, tag) < 0 && current.immutable !== true, 'TARGET_INVALID', 'Unsafe historical draft target.');
      let changed = false;
      if (!current.draft) {
        const converted = await adapter.patchDraft(current.id);
        guard(converted.draft === true, 'DRAFT_FAILED', 'GitHub did not confirm historical draft conversion.');
        same(releaseState(converted), releaseState(target), 'ASSET_CHANGED', 'Historical metadata or assets changed while drafting.');
        changed = true;
      }
      const confirmed = await adapter.getRelease(target.id);
      guard(confirmed.draft === true, 'DRAFT_FAILED', 'Historical draft read-back failed.');
      same(releaseState(confirmed), releaseState(target), 'ASSET_CHANGED', 'Historical assets did not survive draft conversion.');
      const checkpoint = {id: target.id, tag: target.tag_name, changed, asset_count: target.assets.length, assets_unchanged: true};
      report.hidden.push(checkpoint); await record(`hidden-${target.id}`, checkpoint);
    }
    phase = 'final_public_verification'; await verifyFinal(adapter, baseline, targets);
    Object.assign(report, {success: true, no_op: targets.length === 0, public_release_count: 1, latest_unchanged: true, gates_unchanged: true, tags_unchanged: true, all_assets_preserved: true});
    await record('result', report); return report;
  } catch (error) {
    Object.assign(report, {success: false, failed_phase: phase, error: safeError(error), rollback_or_republish_attempted: false});
    try { await record('failure', report); } catch { report.evidence_write_failed = true; }
    return report;
  }
}

function parseArgs(argv) {
  const result = {apply: false, verifyCurrent: false, waitSeconds: 0, gh: 'gh'};
  const seen = new Set();
  for (let index = 0; index < argv.length; index++) {
    const name = argv[index]; guard(!seen.has(name), 'OPTIONS_INVALID', 'Duplicate command option.'); seen.add(name);
    if (name === '--apply') result.apply = true;
    else if (name === '--verify-current') result.verifyCurrent = true;
    else {
      guard(['--tag', '--output', '--wait-seconds', '--gh'].includes(name), 'OPTIONS_INVALID', 'Unknown command option.');
      const value = argv[++index]; guard(typeof value === 'string' && value && !value.startsWith('--'), 'OPTIONS_INVALID', 'Missing command option value.');
      if (name === '--tag') { parseVersion(value); result.tag = value; }
      if (name === '--output') result.output = path.resolve(value);
      if (name === '--gh') result.gh = value;
      if (name === '--wait-seconds') { guard(/^\d+$/.test(value), 'OPTIONS_INVALID', 'Pages wait must be an integer.'); result.waitSeconds = Number(value); }
    }
  }
  guard(result.output, 'OPTIONS_INVALID', 'A fresh evidence output directory is required.');
  guard(Number.isInteger(result.waitSeconds) && result.waitSeconds >= 0 && result.waitSeconds <= 900, 'OPTIONS_INVALID', 'Pages wait must be between 0 and 900 seconds.');
  return result;
}
async function readBody(response, maximum, keepBytes) {
  let size = 0; const digest = crypto.createHash('sha256'), chunks = [];
  for await (const chunk of response.body || []) { size += chunk.length; guard(size <= maximum, 'PUBLIC_ASSET_OVERSIZED', 'Public response exceeded its approved size.'); digest.update(chunk); if (keepBytes) chunks.push(Buffer.from(chunk)); }
  return {size, sha256: digest.digest('hex'), ...(keepBytes ? {bytes: Buffer.concat(chunks)} : {})};
}
class GhAdapter {
  constructor(options) { this.gh = options.gh || 'gh'; this.output = options.output; }
  now() { return Date.now(); }
  sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
  auth(endpoint, extra = [], input) {
    try { return JSON.parse(execFileSync(this.gh, ['api', endpoint, ...extra], {input, windowsHide: true, encoding: 'utf8', timeout: 45000, maxBuffer: 32 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe']})); }
    catch { throw new GuardError('GITHUB_OPERATION_FAILED', 'GitHub API operation failed; raw command output is intentionally omitted.'); }
  }
  list(endpoint) { return this.auth(endpoint, ['--paginate', '--slurp']).flat(); }
  getRepository() { return this.auth(`repos/${REPOSITORY}`); }
  getLatest() { return this.auth(`repos/${REPOSITORY}/releases/latest`); }
  listReleases() { return this.list(`repos/${REPOSITORY}/releases?per_page=100`); }
  listTags() { return this.list(`repos/${REPOSITORY}/tags?per_page=100`).map(tag => ({name: tag.name, sha: tag.commit.sha})); }
  getRelease(id) { return this.auth(`repos/${REPOSITORY}/releases/${id}`); }
  patchDraft(id) { return this.auth(`repos/${REPOSITORY}/releases/${id}`, ['--method', 'PATCH', '--input', '-'], JSON.stringify({draft: true, make_latest: 'false'})); }
  getGate(edition) {
    guard(['lite', 'general'].includes(edition), 'GATE_INVALID', 'Unknown gate.');
    const source = this.auth(`repos/${REPOSITORY}/contents/${edition}-update.json?ref=main`);
    guard(source.encoding === 'base64' && typeof source.content === 'string', 'GATE_INVALID', 'Repository update gate is unavailable.');
    const bytes = Buffer.from(source.content.replace(/\s/g, ''), 'base64');
    let value; try { value = JSON.parse(bytes); } catch { throw new GuardError('GATE_INVALID', 'Repository update gate is invalid JSON.'); }
    return {sha: source.sha, bytes, value};
  }
  async request(url, method = 'GET') {
    return fetch(url, {method, cache: 'no-store', redirect: 'follow', signal: AbortSignal.timeout(method === 'HEAD' ? 30000 : 180000), headers: {'User-Agent': 'SpoonMate-Lite-retention', Accept: 'application/vnd.github+json'}});
  }
  async publicJson(url) { const response = await this.request(url); guard(response.status === 200, 'PUBLIC_API_UNAVAILABLE', 'Public GitHub API is unavailable.'); const body = await readBody(response, 32 * 1024 * 1024, true); try { return JSON.parse(body.bytes); } catch { throw new GuardError('PUBLIC_API_INVALID', 'Public GitHub response is invalid JSON.'); } }
  getPublicLatest() { return this.publicJson(`https://api.github.com/repos/${REPOSITORY}/releases/latest`); }
  async getPublicReleases() {
    const values = [];
    for (let page = 1; page <= 1000; page++) {
      const rows = await this.publicJson(`https://api.github.com/repos/${REPOSITORY}/releases?per_page=100&page=${page}`);
      guard(Array.isArray(rows), 'PUBLIC_API_INVALID', 'Public release listing is not an array.'); values.push(...rows);
      if (rows.length < 100) return values;
    }
    throw new GuardError('PUBLIC_API_INVALID', 'Public release pagination exceeded the safety limit.');
  }
  async getPublicGate(edition) { const response = await this.request(`${SITE}/${edition}-update.json?retention=${Date.now()}`); return {status: response.status, ...(response.status === 200 ? await readBody(response, 65536, true) : {bytes: Buffer.alloc(0)})}; }
  async readPublicAsset(tag, asset, bytes) { const response = await this.request(downloadUrl(tag, asset.name)); return {status: response.status, ...(response.status === 200 ? await readBody(response, asset.size, bytes) : {})}; }
  async publicAssetStatus(tag, name) { return (await this.request(downloadUrl(tag, name), 'HEAD')).status; }
  async publicReleaseStatus(id) { return (await this.request(`https://api.github.com/repos/${REPOSITORY}/releases/${id}`)).status; }
  writeEvidence(name, value) {
    guard(/^[a-z0-9-]+$/.test(name), 'EVIDENCE_INVALID', 'Invalid evidence filename.');
    fs.writeFileSync(path.join(this.output, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`, {flag: 'wx'});
  }
  async probeUpdater(input) {
    const temporaryBase = fs.realpathSync(os.tmpdir()), profile = fs.mkdtempSync(path.join(temporaryBase, 'spoonmate-retention-probe-'));
    try {
      const env = {...process.env}; delete env.GH_TOKEN; delete env.GITHUB_TOKEN; delete env.ELECTRON_RUN_AS_NODE;
      return await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [__filename, '--internal-probe', JSON.stringify({...input, profile})], {env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
        let stdout = '', timedOut = false;
        const timer = setTimeout(() => { timedOut = true; child.kill(); }, 60000);
        child.stdout.on('data', chunk => { stdout += chunk.toString(); if (stdout.length > 65536) { timedOut = true; child.kill(); } });
        // Deliberately discard stderr. A dependency/network failure must not
        // print credentials, redirect signatures or arbitrary provider text.
        child.stderr.resume();
        child.on('error', () => { clearTimeout(timer); reject(new GuardError('UPDATER_PROBE_FAILED', 'The isolated updater could not start.')); });
        child.on('close', code => { clearTimeout(timer); if (timedOut) return reject(new GuardError('UPDATER_PROBE_TIMEOUT', 'The isolated updater exceeded its time limit.')); if (code !== 0) return reject(new GuardError('UPDATER_PROBE_FAILED', 'The isolated real updater failed.')); try { resolve(JSON.parse(stdout)); } catch { reject(new GuardError('UPDATER_PROBE_FAILED', 'The isolated updater returned invalid evidence.')); } });
      });
    } finally {
      const resolved = fs.realpathSync(profile);
      guard(!fs.lstatSync(profile).isSymbolicLink() && path.dirname(resolved) === temporaryBase && path.basename(resolved).startsWith('spoonmate-retention-probe-'), 'TEMP_PATH_INVALID', 'Refusing to remove an unexpected probe path.');
      fs.rmSync(resolved, {recursive: true, force: true, maxRetries: 5, retryDelay: 100});
    }
  }
}
async function internalProbe(value) {
  guard(process.platform === 'win32', 'UPDATER_PLATFORM_INVALID', 'Run the real NSIS publication probe on Windows.');
  const input = JSON.parse(value), temporaryBase = fs.realpathSync(os.tmpdir()), profile = fs.realpathSync(input.profile);
  guard(path.dirname(profile) === temporaryBase && path.basename(profile).startsWith('spoonmate-retention-probe-') && !fs.lstatSync(input.profile).isSymbolicLink(), 'TEMP_PATH_INVALID', 'Invalid isolated updater profile.');
  const lookup = moduleName => require(require.resolve(moduleName, {paths: [__dirname, path.resolve(__dirname, '../..')]}));
  const {NsisUpdater} = lookup('electron-updater'), {NodeHttpExecutor} = lookup('builder-util/out/nodeHttpExecutor');
  const app = {version: internalVersion(`v${input.previousDisplay}`), name: 'SpoonMate-Lite-retention-readonly', isPackaged: true, userDataPath: profile, baseCachePath: profile, appUpdateConfigPath: path.join(profile, 'unused.yml'), whenReady: async () => {}, onQuit: () => {}, relaunch: () => { throw new Error('Forbidden'); }, quit: () => { throw new Error('Forbidden'); }};
  const updater = new NsisUpdater(null, app); updater.httpExecutor = new NodeHttpExecutor(); updater.logger = {info() {}, warn() {}, error() {}, debug() {}};
  updater.autoDownload = false; updater.autoInstallOnAppQuit = false; updater.allowPrerelease = false; updater.allowDowngrade = false; updater.channel = 'lite';
  updater.downloadUpdate = () => { throw new GuardError('PROBE_DOWNLOAD_FORBIDDEN', 'Downloading an updater payload is forbidden in the version probe.'); };
  updater.quitAndInstall = () => { throw new GuardError('PROBE_INSTALL_FORBIDDEN', 'Installation is forbidden in the version probe.'); };
  updater.setFeedURL({provider: 'github', owner: 'gisun5689', repo: 'spoonmate', channel: 'lite'});
  let detected; updater.on('update-available', info => { detected = info; });
  await updater.checkForUpdates();
  guard(detected?.version === input.targetInternal && detected.files?.some(file => file.url === input.installerName && file.size === input.installerSize), 'UPDATER_INVALID', 'Real GitHub updater did not detect the exact target.');
  guard(updater.autoDownload === false && updater.autoInstallOnAppQuit === false, 'UPDATER_INVALID', 'Unsafe updater probe settings.');
  return {success: true, detected_internal_version: detected.version, previous_display_version: input.previousDisplay, checks: 'standalone real NsisUpdater + public GitHub provider', download_performed: false, install_performed: false, production_user_data_accessed: false};
}
async function cli(argv) {
  const options = parseArgs(argv);
  guard(!fs.existsSync(options.output), 'EVIDENCE_EXISTS', 'Use a new, non-existing evidence output directory for every attempt.');
  fs.mkdirSync(path.dirname(options.output), {recursive: true}); fs.mkdirSync(options.output);
  const result = await runRetention(options, new GhAdapter(options));
  console.log(JSON.stringify(result, null, 2)); if (!result.success) process.exitCode = 1;
  return result;
}
module.exports = {REPOSITORY, GuardError, parseVersion, compareVersion, internalVersion, previousVersion, assetState, releaseState, validateLatest, selectPlan, parseArgs, runRetention, GhAdapter};
if (require.main === module) {
  if (process.argv[2] === '--internal-probe') internalProbe(process.argv[3]).then(result => { process.stdout.write(JSON.stringify(result)); process.exit(0); }).catch(() => process.exit(1));
  else cli(process.argv.slice(2)).catch(error => { console.error(JSON.stringify({success: false, error: safeError(error)})); process.exitCode = 1; });
}

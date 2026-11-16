'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {REPOSITORY, parseVersion, compareVersion, internalVersion, previousVersion, selectPlan, parseArgs, runRetention, GhAdapter} = require('../.github/release-tools/retention.cjs');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
function release(revision, draft = false) {
  const version = `2.0.15.${revision}`, tag = `v${version}`, id = revision + 1000;
  const installer = `SpoonMate_Lite_Setup_v${version}_x64_UNSIGNED.exe`;
  const payloads = new Map([[installer, Buffer.from(`fixture installer ${version}`)], [`${installer}.blockmap`, Buffer.from(`fixture blockmap ${version}`)], ['lite.yml', Buffer.from(`version: 2.0.15${revision}\n`)]]);
  const manifest = {schema_version: 1, edition: 'lite', channel: 'lite', display_version: version, internal_version: `2.0.15${revision}`, repository: REPOSITORY, files: [...payloads].map(([name, bytes]) => ({file_name: name, size: bytes.length, sha256: hash(bytes)}))};
  payloads.set('SpoonMate_LITE_Update_Release_Manifest.json', Buffer.from(JSON.stringify(manifest)));
  const value = {id, tag_name: tag, target_commitish: 'main', name: `SpoonMate Lite v${version}`, body: `Fixture ${version}`, draft, prerelease: false, immutable: false, assets: [...payloads].map(([name, bytes], index) => ({id: id * 10 + index, name, size: bytes.length, digest: `sha256:${hash(bytes)}`, state: 'uploaded', browser_download_url: `https://github.com/${REPOSITORY}/releases/download/${tag}/${name}`}))};
  return {value, payloads};
}
class FixtureAdapter {
  constructor({older = [107, 106], drafts = [105], hook} = {}) {
    const current = release(108); this.latestId = current.value.id; this.releases = new Map([[this.latestId, current.value]]); this.payloads = new Map();
    for (const item of [current, ...older.map(value => release(value)), ...drafts.map(value => release(value, true))]) { this.releases.set(item.value.id, item.value); for (const [name, bytes] of item.payloads) this.payloads.set(`${item.value.tag_name}/${name}`, bytes); }
    const liteValue = {schema_version: 1, edition: 'lite', channel: 'lite', latest_display_version: '2.0.15.108', latest_internal_version: '2.0.15108', release_tag: 'v2.0.15.108', release_page_url: `https://github.com/${REPOSITORY}/releases/tag/v2.0.15.108`, published: true};
    const generalValue = {schema_version: 1, edition: 'dev', channel: 'dev', published: false, latest_display_version: '2.0.15.102'};
    this.gates = {lite: {sha: 'lite-sha', bytes: Buffer.from(JSON.stringify(liteValue)), value: liteValue}, general: {sha: 'general-sha', bytes: Buffer.from(JSON.stringify(generalValue)), value: generalValue}};
    this.tags = [...this.releases.values()].map(item => ({name: item.tag_name, sha: `sha-${item.id}`}));
    this.calls = []; this.counts = {}; this.patches = []; this.evidence = new Map(); this.clock = 1794800000000; this.hook = hook;
  }
  event(name, argument) { this.calls.push({name, argument}); this.counts[name] = (this.counts[name] || 0) + 1; this.hook?.(name, this.counts[name], this, argument); }
  now() { return this.clock; }
  async sleep(ms) { this.event('sleep', ms); this.clock += ms; }
  async getRepository() { this.event('getRepository'); return {full_name: REPOSITORY, visibility: 'public', private: false, permissions: {push: true}}; }
  async getLatest() { this.event('getLatest'); return clone(this.releases.get(this.latestId)); }
  async listReleases() { this.event('listReleases'); return clone([...this.releases.values()]); }
  async listTags() { this.event('listTags'); return clone(this.tags); }
  async getRelease(id) { this.event('getRelease', id); return clone(this.releases.get(id)); }
  async getGate(edition) { this.event(`getGate-${edition}`); const result = this.gates[edition]; return {sha: result.sha, bytes: Buffer.from(result.bytes), value: clone(result.value)}; }
  async getPublicGate(edition) { this.event(`getPublicGate-${edition}`); return {status: 200, bytes: Buffer.from(this.gates[edition].bytes)}; }
  async getPublicLatest() { this.event('getPublicLatest'); return clone(this.releases.get(this.latestId)); }
  async getPublicReleases() { this.event('getPublicReleases'); return clone([...this.releases.values()].filter(item => !item.draft)); }
  async readPublicAsset(tag, asset, keepBytes) { this.event('readPublicAsset', asset.name); const bytes = this.payloads.get(`${tag}/${asset.name}`); return {status: 200, size: bytes.length, sha256: hash(bytes), ...(keepBytes ? {bytes: Buffer.from(bytes)} : {})}; }
  async probeUpdater(input) { this.event('probeUpdater', input); return {success: true, detected_internal_version: input.targetInternal, download_performed: false, install_performed: false, production_user_data_accessed: false}; }
  async patchDraft(id) { this.event('patchDraft', id); this.patches.push(id); const item = this.releases.get(id); item.draft = true; for (const asset of item.assets) asset.browser_download_url = `https://github.com/${REPOSITORY}/releases/download/untagged-fixture/${asset.name}`; return clone(item); }
  async publicAssetStatus(tag) { this.event('publicAssetStatus', tag); return [...this.releases.values()].some(item => item.tag_name === tag && !item.draft) ? 200 : 404; }
  async publicReleaseStatus(id) { this.event('publicReleaseStatus', id); return this.releases.get(id)?.draft ? 404 : 200; }
  async writeEvidence(name, value) { assert(!this.evidence.has(name), 'Evidence is immutable'); this.evidence.set(name, clone(value)); }
}
const apply = (adapter, extra = {}) => runRetention({apply: true, ...extra}, adapter);
const assertNoWrite = (result, adapter, code) => { assert.equal(result.success, false); assert.equal(adapter.patches.length, 0); if (code) assert.equal(result.error.code, code); };

test('successful publication checks full payloads and real-updater adapter before older drafts', async () => {
  const adapter = new FixtureAdapter(); const result = await apply(adapter);
  assert.equal(result.success, true); assert.equal(result.fresh_live_verification, true);
  assert.deepEqual(adapter.patches, [1107, 1106]); assert.equal(adapter.releases.get(1108).draft, false);
  assert.equal(result.public_release_count, 1); assert.equal(result.deleted_assets, 0);
  assert.equal(adapter.counts.readPublicAsset, 4); assert.equal(adapter.counts.probeUpdater, 1);
  assert(adapter.calls.findIndex(call => call.name === 'patchDraft') > adapter.calls.findIndex(call => call.name === 'probeUpdater'));
  assert(adapter.evidence.has('before')); assert(adapter.evidence.has('fresh-verification')); assert(adapter.evidence.has('result'));
});
test('GitHub App repository metadata without user-style permissions supports the verified flow', async () => {
  const adapter = new FixtureAdapter();
  adapter.getRepository = async () => ({full_name: REPOSITORY, private: false, visibility: 'public'});
  const result = await apply(adapter);
  assert.equal(result.success, true); assert.equal(result.fresh_live_verification, true); assert.deepEqual(adapter.patches, [1107, 1106]); assert.equal(adapter.releases.get(1108).draft, false);
});
test('actual PATCH authorization denial fails without hiding history or leaking provider text', async () => {
  const adapter = new FixtureAdapter();
  adapter.getRepository = async () => ({full_name: REPOSITORY, private: false, visibility: 'public'});
  adapter.patchDraft = async () => { adapter.event('patchDraft'); throw new Error('HTTP 403 PRIVATE_TOKEN_SENTINEL'); };
  const result = await apply(adapter);
  assertNoWrite(result, adapter, 'OPERATION_FAILED'); assert.equal(result.fresh_live_verification, true); assert.equal(result.hidden.length, 0); assert.equal(adapter.counts.patchDraft, 1);
  assert.equal(adapter.releases.get(1107).draft, false); assert.equal(adapter.releases.get(1106).draft, false); assert.equal(adapter.releases.get(1108).draft, false); assert(!JSON.stringify(result).includes('PRIVATE_TOKEN_SENTINEL'));
});
test('default dry run fully verifies but never writes', async () => {
  const adapter = new FixtureAdapter(); const result = await runRetention({}, adapter);
  assert.equal(result.success, true); assert.equal(result.dry_run, true); assert.equal(result.planned.length, 2); assert.equal(adapter.patches.length, 0); assert.equal(adapter.releases.get(1107).draft, false);
});
test('already drafted history is fast idempotent no-op without imported PASS', async () => {
  const adapter = new FixtureAdapter({older: [], drafts: [107, 106]}); const result = await apply(adapter);
  assert.equal(result.success, true); assert.equal(result.no_op, true); assert.equal(result.fresh_live_verification, false); assert.equal(adapter.patches.length, 0); assert.equal(adapter.counts.probeUpdater, undefined);
});
test('--verify-current forces fresh downloads and updater even with no older public release', async () => {
  const adapter = new FixtureAdapter({older: [], drafts: [107]}); const result = await apply(adapter, {verifyCurrent: true});
  assert.equal(result.success, true); assert.equal(result.no_op, true); assert.equal(result.fresh_live_verification, true); assert.equal(adapter.counts.probeUpdater, 1); assert.equal(adapter.patches.length, 0);
});
test('an old successful evidence object cannot bypass a fresh download failure', async () => {
  const adapter = new FixtureAdapter(); adapter.evidence.set('old-pass', {success: true}); adapter.readPublicAsset = async () => ({status: 503});
  assertNoWrite(await apply(adapter), adapter, 'PUBLIC_ASSET_INVALID');
});
test('public Pages lag fails closed with no old release writes', async () => {
  const adapter = new FixtureAdapter(); adapter.getPublicGate = async () => ({status: 200, bytes: Buffer.from('{}')});
  assertNoWrite(await apply(adapter), adapter, 'PUBLIC_GATE_NOT_READY');
});
test('Pages wait is bounded and only retries the public Lite gate', async () => {
  const adapter = new FixtureAdapter(); const original = adapter.getPublicGate.bind(adapter); let failures = 2;
  adapter.getPublicGate = async edition => edition === 'lite' && failures-- > 0 ? {status: 404, bytes: Buffer.alloc(0)} : original(edition);
  const result = await apply(adapter, {waitSeconds: 5}); assert.equal(result.success, true); assert.equal(adapter.counts.sleep, 2);
});
test('exhausted public Pages wait leaves all historical releases public', async () => {
  const adapter = new FixtureAdapter(); adapter.getPublicGate = async () => ({status: 404, bytes: Buffer.alloc(0)});
  assertNoWrite(await apply(adapter, {waitSeconds: 3}), adapter, 'PUBLIC_GATE_NOT_READY'); assert.equal(adapter.clock, 1794800003000);
});
test('unpublished or mismatched authenticated gate blocks before any payload downloads', async t => {
  for (const change of [gate => { gate.value.published = false; }, gate => { gate.value.latest_display_version = '2.0.15.107'; }, gate => { gate.value.release_tag = 'v2.0.15.107'; }]) await t.test(String(change), async () => { const adapter = new FixtureAdapter(); change(adapter.gates.lite); assertNoWrite(await apply(adapter), adapter, 'LITE_GATE_INVALID'); assert.equal(adapter.counts.readPublicAsset, undefined); });
});
test('General publication or public General drift blocks cleanup', async t => {
  await t.test('authenticated General published', async () => { const adapter = new FixtureAdapter(); adapter.gates.general.value.published = true; assertNoWrite(await apply(adapter), adapter, 'GENERAL_GATE_INVALID'); });
  await t.test('public General bytes drift', async () => { const adapter = new FixtureAdapter(); const original = adapter.getPublicGate.bind(adapter); adapter.getPublicGate = async name => name === 'general' ? {status: 200, bytes: Buffer.from('{}')} : original(name); assertNoWrite(await apply(adapter), adapter, 'PUBLIC_GENERAL_GATE_CHANGED'); });
});
test('real updater mismatch and unsafe updater behavior fail closed', async t => {
  for (const response of [{success: false}, {success: true, detected_internal_version: '2.0.15107'}, {success: true, detected_internal_version: '2.0.15108', download_performed: true, install_performed: false, production_user_data_accessed: false}]) await t.test(JSON.stringify(response), async () => { const adapter = new FixtureAdapter(); adapter.probeUpdater = async () => response; assertNoWrite(await apply(adapter), adapter, 'UPDATER_INVALID'); });
});
test('payload bytes mismatch and remote digest mismatch each block all writes', async t => {
  await t.test('bytes', async () => { const adapter = new FixtureAdapter(); const latest = adapter.releases.get(1108), installer = latest.assets.find(asset => asset.name.endsWith('.exe')); adapter.payloads.set(`${latest.tag_name}/${installer.name}`, Buffer.from('corrupt')); assertNoWrite(await apply(adapter), adapter, 'PUBLIC_ASSET_INVALID'); });
  await t.test('digest', async () => { const adapter = new FixtureAdapter(); adapter.releases.get(1108).assets[0].digest = `sha256:${'0'.repeat(64)}`; assertNoWrite(await apply(adapter), adapter, 'MANIFEST_INVALID'); });
});
test('mixed-edition, extra and duplicate newest assets are refused', async t => {
  for (const change of [assets => { assets[0].name = 'SpoonMate_General.exe'; }, assets => { assets.push(clone(assets[0])); }, assets => { assets[0].id = assets[1].id; }]) await t.test(String(change), async () => { const adapter = new FixtureAdapter(); change(adapter.releases.get(1108).assets); assertNoWrite(await apply(adapter), adapter, 'LATEST_ASSETS_INVALID'); });
});
test('manifest, metadata, blockmap and installer each have a bounded download size', async t => {
  const limits = [['SpoonMate_LITE_Update_Release_Manifest.json', 64 * 1024], ['lite.yml', 1024 * 1024], ['.blockmap', 32 * 1024 * 1024], ['.exe', 512 * 1024 * 1024]];
  for (const [suffix, maximum] of limits) await t.test(suffix, async () => { const adapter = new FixtureAdapter(); adapter.releases.get(1108).assets.find(asset => asset.name.endsWith(suffix)).size = maximum + 1; assertNoWrite(await apply(adapter), adapter, 'LATEST_ASSETS_INVALID'); assert.equal(adapter.counts.readPublicAsset, undefined); });
});
test('unknown, newer, prerelease and immutable public history fails before verification or mutation', async t => {
  const scenarios = [['unknown', value => { value.tag_name = 'nightly'; }, 'TAG_INVALID'], ['newer', value => { value.tag_name = 'v2.0.15.109'; }, 'NEWER_RELEASE_PRESENT'], ['equal', value => { value.tag_name = 'v2.0.15.108'; }, 'NEWER_RELEASE_PRESENT'], ['prerelease', value => { value.prerelease = true; }, 'UNEXPECTED_PRERELEASE'], ['immutable', value => { value.immutable = true; }, 'IMMUTABLE_RELEASE']];
  for (const [name, change, code] of scenarios) await t.test(name, async () => { const adapter = new FixtureAdapter(); change(adapter.releases.get(1107)); assertNoWrite(await apply(adapter), adapter, code); assert.equal(adapter.counts.readPublicAsset, undefined); });
});
test('unknown prepared draft is not a publication target', async () => {
  const adapter = new FixtureAdapter(); adapter.releases.get(1105).tag_name = 'prepared-next-draft'; const result = await apply(adapter); assert.equal(result.success, true); assert.deepEqual(adapter.patches, [1107, 1106]);
});
test('artifact evidence omits existing private draft details and all raw release bodies or URLs', async () => {
  const adapter = new FixtureAdapter(); const draft = adapter.releases.get(1105);
  draft.body = 'PRIVATE_DRAFT_SENTINEL'; draft.name = 'PRIVATE_NAME_SENTINEL'; draft.tag_name = 'PRIVATE_TAG_SENTINEL'; draft.assets[0].browser_download_url = 'https://private.invalid/PRIVATE_URL_SENTINEL';
  adapter.releases.get(1108).body = 'PUBLIC_BODY_NOT_NEEDED_IN_ARTIFACT';
  const result = await apply(adapter); assert.equal(result.success, true);
  const output = JSON.stringify([...adapter.evidence.values()]);
  for (const text of ['PRIVATE_DRAFT_SENTINEL', 'PRIVATE_NAME_SENTINEL', 'PRIVATE_TAG_SENTINEL', 'PRIVATE_URL_SENTINEL', 'PUBLIC_BODY_NOT_NEEDED_IN_ARTIFACT', 'browser_download_url']) assert(!output.includes(text), text);
  assert.equal(adapter.evidence.get('before').existing_drafts_count, 1); assert.equal(adapter.evidence.get('before').public_inventory.length, 3); assert.match(adapter.evidence.get('before').latest.body_sha256, /^[a-f0-9]{64}$/);
});
test('latest becoming draft, prerelease or another version stops all historical writes', async t => {
  for (const change of [item => { item.draft = true; }, item => { item.prerelease = true; }, item => { item.tag_name = 'v2.0.15.109'; }]) await t.test(String(change), async () => { const adapter = new FixtureAdapter(); change(adapter.releases.get(1108)); assertNoWrite(await apply(adapter), adapter, 'LATEST_INVALID'); });
});
test('fresh verification detects a newer public release race before first write', async () => {
  const adapter = new FixtureAdapter({hook(name, count, a) { if (name === 'getLatest' && count === 2) { const newer = release(109); a.releases.set(newer.value.id, newer.value); a.latestId = newer.value.id; } }});
  assertNoWrite(await apply(adapter), adapter, 'LATEST_INVALID'); assert.equal(adapter.releases.get(1109).draft, false);
});
test('before-each-write guard stops a second write when the Lite gate changes', async () => {
  const adapter = new FixtureAdapter({hook(name, count, a) { if (name === 'patchDraft' && count === 1) a.gates.lite.sha = 'concurrent-sha'; }});
  const result = await apply(adapter); assert.equal(result.success, false); assert.equal(result.error.code, 'LITE_GATE_CHANGED'); assert.deepEqual(adapter.patches, [1107]); assert.equal(adapter.releases.get(1106).draft, false); assert.equal(adapter.releases.get(1108).draft, false); assert.equal(result.rollback_or_republish_attempted, false);
});
test('partial failure is resumable and never republishes the already drafted history', async () => {
  const adapter = new FixtureAdapter({hook(name, count) { if (name === 'patchDraft' && count === 2) throw new Error('private arbitrary provider text'); }});
  const first = await apply(adapter); assert.equal(first.success, false); assert.deepEqual(adapter.patches, [1107]); assert.equal(first.hidden.length, 1); assert(!JSON.stringify(first).includes('private arbitrary'));
  adapter.hook = undefined; adapter.evidence = new Map(); const second = await apply(adapter); assert.equal(second.success, true); assert.deepEqual(adapter.patches, [1107, 1106]); assert.equal(second.planned.length, 1);
});
test('a target already drafted concurrently is read back but not patched twice', async () => {
  const adapter = new FixtureAdapter({hook(name, count, a, id) { if (name === 'getRelease' && count === 1) a.releases.get(id).draft = true; }});
  const result = await apply(adapter); assert.equal(result.success, true); assert.deepEqual(adapter.patches, [1106]); assert.equal(result.hidden[0].changed, false);
});
test('GitHub draft URL rewriting does not invalidate unchanged asset identity and bytes', async () => {
  const adapter = new FixtureAdapter(); const before = clone(adapter.releases.get(1107).assets); const result = await apply(adapter); assert.equal(result.success, true);
  const after = adapter.releases.get(1107).assets; assert.match(after[0].browser_download_url, /untagged/); assert.deepEqual(after.map(({browser_download_url, ...item}) => item), before.map(({browser_download_url, ...item}) => item));
});
test('historical asset change before patch is not hidden', async () => {
  const adapter = new FixtureAdapter({hook(name, count, a, id) { if (name === 'getRelease' && count === 1) a.releases.get(id).assets[0].size++; }});
  assertNoWrite(await apply(adapter), adapter, 'ASSET_CHANGED');
});
test('tag changes prevent cleanup after public checks but before any writes', async () => {
  const adapter = new FixtureAdapter({hook(name, count, a) { if (name === 'listTags' && count === 2) a.tags[0].sha = 'changed-tag'; }});
  assertNoWrite(await apply(adapter), adapter, 'TAGS_CHANGED');
});
test('final anonymous visibility failure is an error without rollback or latest mutation', async () => {
  const adapter = new FixtureAdapter(); adapter.publicReleaseStatus = async () => 200; const result = await apply(adapter);
  assert.equal(result.success, false); assert.equal(result.error.code, 'OLD_RELEASE_ACCESSIBLE'); assert.equal(adapter.releases.get(1108).draft, false); assert.equal(result.rollback_or_republish_attempted, false);
});
test('more than 100 release rows are processed, not truncated to the first page', async () => {
  const adapter = new FixtureAdapter({older: Array.from({length: 107}, (_, index) => index + 1), drafts: []}); const result = await apply(adapter);
  assert.equal(result.success, true); assert.equal(adapter.patches.length, 107); assert.equal(result.hidden.length, 107);
});
test('authenticated adapter explicitly requests paginated release and tag pages', () => {
  const adapter = new GhAdapter({output: 'unused'}); const requests = [];
  adapter.auth = (endpoint, args) => { requests.push({endpoint, args}); return [[{name: 'v2.0.15.1', commit: {sha: 'one'}}], [{name: 'v2.0.15.2', commit: {sha: 'two'}}]]; };
  assert.equal(adapter.listReleases().length, 2); assert.equal(adapter.listTags().length, 2); assert(requests.every(request => JSON.stringify(request.args) === JSON.stringify(['--paginate', '--slurp'])));
});
test('anonymous adapter walks all pages when a page is full', async () => {
  const adapter = new GhAdapter({output: 'unused'}); const urls = [];
  adapter.publicJson = async url => { urls.push(url); return url.endsWith('page=1') ? Array.from({length: 100}, (_, id) => ({id})) : [{id: 100}]; };
  assert.equal((await adapter.getPublicReleases()).length, 101); assert.equal(urls.length, 2); assert.match(urls[1], /page=2$/);
});
test('four-part ordering is numeric and updater previous version is strictly older', () => {
  assert.equal(compareVersion('v2.0.15.9', 'v2.0.15.10'), -1); assert.equal(compareVersion('v2.0.15.100', 'v2.0.15.99'), 1); assert.equal(internalVersion('v2.0.15.108'), '2.0.15108');
  assert.equal(previousVersion([], 'v2.0.15.108'), '2.0.15.107'); assert.equal(previousVersion([{tag_name: 'v2.0.15.9'}, {tag_name: 'v2.0.15.107'}], 'v2.0.15.108'), '2.0.15.107');
  for (const tag of ['v2.0.15.0108', 'v2.0.15.108-beta', '2.0.15.108', 'nightly', 'v2.0.15.9007199254740992']) assert.throws(() => parseVersion(tag));
  assert.equal(previousVersion([{tag_name: 'v2.0.1.99'}, {tag_name: 'v2.0.2.0'}], 'v2.0.15.108'), '2.0.1.99');
});
test('minor reset that lowers the concatenated internal version is rejected even for draft history', () => {
  const latest = {id: 9000, tag_name: 'v2.0.16.1', draft: false}, old = {...release(107, true).value};
  assert.throws(() => selectPlan([latest, old], latest, latest.tag_name), error => error.code === 'UPDATER_VERSION_NON_MONOTONIC');
});
test('CLI defaults to read-only, requires fresh output and rejects ambiguous options', () => {
  const options = parseArgs(['--output', 'some-new-evidence']); assert.equal(options.apply, false); assert.equal(options.waitSeconds, 0); assert.equal(options.gh, 'gh');
  assert.equal(parseArgs(['--output', 'a', '--tag', 'v2.0.15.108', '--apply', '--verify-current', '--wait-seconds', '900', '--gh', 'C:/gh.exe']).apply, true);
  for (const args of [[], ['--output', 'a', '--apply', '--apply'], ['--output', 'a', '--wat'], ['--output', 'a', '--wait-seconds', '901'], ['--output', 'a', '--wait-seconds', '-1'], ['--output', '--apply'], ['--output', 'a', '--tag', 'latest']]) assert.throws(() => parseArgs(args));
});
test('standalone production adapter never imports app modules or requests user data', () => {
  const source = fs.readFileSync(path.join(__dirname, '../.github/release-tools/retention.cjs'), 'utf8');
  assert(!source.includes("require('../sunmodules")); assert(source.includes('updater.autoDownload = false')); assert(source.includes('updater.autoInstallOnAppQuit = false'));
  assert(source.includes("process.platform === 'win32'")); assert(source.includes('path.dirname(resolved) === temporaryBase')); assert(source.includes("[__filename, '--internal-probe'"));
});

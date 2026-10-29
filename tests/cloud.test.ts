import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, copyFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fixture, PNG } from './helpers.js';
import {
  CloudSync,
  GithubClient,
  syncDirection,
  snapshotDigest,
} from '../src/desktop/github-sync.js';
import { addAttachment, backupBeforeV3Migration, inspectDatabase, unpackBackup } from '../src/desktop/backups.js';
import { Store } from '../src/desktop/store.js';

class Server {
  privateRepo = true;
  files = new Map<string, { bytes: Buffer; sha: string }>();
  beforePut: (() => void) | null = null;
  fetch: typeof fetch = (async (url: any, options: any = {}) => {
    assert.ok(String(url).startsWith('https://api.github.com/'));
    const path = new URL(url).pathname;
    if (path === '/repos/me/lab')
      return Response.json({ private: this.privateRepo, archived: false, disabled: false });
    if (path === '/user') return Response.json({ login: 'me' });
    const name = path.split('/contents/')[1];
    if (!name) return new Response('', { status: 404 });
    if (options.method === 'PUT') {
      if (name.endsWith('latest.json') && this.beforePut) {
        const hook = this.beforePut;
        this.beforePut = null;
        hook();
      }
      const value = JSON.parse(options.body),
        current = this.files.get(name);
      if (current?.sha !== value.sha) return new Response('', { status: 409 });
      const bytes = Buffer.from(value.content, 'base64');
      const sha = createHash('sha1').update(bytes).digest('hex');
      this.files.set(name, { bytes, sha });
      return Response.json({ content: { sha } }, { status: current ? 200 : 201 });
    }
    const entry = this.files.get(name);
    if (!entry) return new Response('', { status: 404 });
    if (options.headers.Accept === 'application/vnd.github.raw+json')
      return new Response(entry.bytes);
    return Response.json({
      type: 'file',
      encoding: 'base64',
      size: entry.bytes.length,
      content: entry.bytes.toString('base64'),
      sha: entry.sha,
    });
  }) as typeof fetch;
}
function syncFor(store: Store, directory: string, server: Server, chunkBytes?: number) {
  return new CloudSync({
    repository: 'me/lab',
    client: new GithubClient('test-only-token', server.fetch),
    statePath: join(directory, 'cloud-state.json'),
    temporaryRoot: directory,
    chunkBytes,
    getStore: () => store,
    install: async (staging) => {
      const checked = inspectDatabase(join(staging, 'records.sqlite'));
      if (checked.schemaVersion < 3)
        assert.ok(await backupBeforeV3Migration(staging, join(directory, 'migration-backups')));
      const staged = checked.schemaVersion < 3 ? new Store(staging) : null;
      const snapshot = staged ? staged.snapshot() : checked;
      staged?.close();
      // Tests install validated records into an empty destination. Production switches directories after backup.
      store.transaction(() => {
        for (const table of [
          'experiments',
          'groups',
          'samples',
          'items',
          'runs',
          'events',
          'attachments',
        ] as const)
          for (const value of snapshot[table]) store.put(table, value as any);
      });
      for (const image of snapshot.attachments)
        await copyFile(join(staging, image.relativePath), join(store.root, image.relativePath));
      return store.snapshot();
    },
  });
}

test('sync uses content baselines rather than clocks and hashes independently of entity ordering', (t) => {
  assert.equal(syncDirection('local', null, null, false), 'upload');
  assert.equal(syncDirection('new', 'base', 'base', false), 'upload');
  assert.equal(syncDirection('base', 'new', 'base', false), 'download');
  assert.equal(syncDirection('new-a', 'new-b', 'base', false), 'conflict');
  assert.equal(syncDirection('local', 'remote', null, false), 'conflict');
  assert.equal(syncDirection('empty', 'remote', null, true), 'download');
  assert.equal(syncDirection('same', 'same', null, false), 'unchanged');
  const { store } = fixture(t);
  store.command({ type: 'demo' });
  const a = store.snapshot(),
    b = structuredClone(a);
  b.groups.reverse();
  b.samples.reverse();
  b.items.reverse();
  assert.equal(snapshotDigest(a), snapshotDigest(b));
});

test('a v1 cloud baseline survives v3 migration without hiding later independent edits', async (t) => {
  const old = fixture(t),
    local = fixture(t),
    server = new Server();
  old.store.command({ type: 'demo' });
  const item = old.store.snapshot().items[0];
  old.store.command({ type: 'start', itemId: item.id });
  old.store.command({ type: 'finish', itemId: item.id });
  const run = old.store.snapshot().runs[0];
  if (run.actualSample) {
    const { state: _state, specimenName: _specimenName, ...v1Sample } = run.actualSample;
    const { actualSources: _actualSources, ...v1Run } = run;
    old.store.put('runs', { ...v1Run, actualSample: v1Sample });
  }

  // Build a genuine schema-v1 database and retain the exact old snapshot hash.
  old.store.db.exec('ALTER TABLE items DROP COLUMN field_note; PRAGMA user_version=1;');
  const currentSnapshot = old.store.snapshot.bind(old.store);
  old.store.snapshot = () => ({ ...currentSnapshot(), schemaVersion: 1 });
  const oldSync = syncFor(old.store, old.directory, server);
  const localSync = syncFor(local.store, local.directory, server);
  assert.equal((await oldSync.sync()).action, 'uploaded');
  const originalPointer = JSON.parse(server.files.get('labrecord/latest.json')!.bytes.toString());

  // A v3 install of a verified v1 backup has the same content, not a local edit.
  assert.equal((await localSync.sync()).action, 'downloaded');
  assert.equal(local.store.snapshot().schemaVersion, 3);
  assert.equal((await localSync.sync()).action, 'unchanged');
  assert.equal((await localSync.state())!.digest, originalPointer.digest);

  // The old computer changes the cloud after the new one has upgraded.
  const group = old.store.snapshot().groups[0];
  old.store.put('groups', { ...group, notes: '旧版电脑修改' });
  assert.equal((await oldSync.sync()).action, 'uploaded');
  assert.equal((await localSync.sync()).action, 'downloaded');
  assert.equal(local.store.snapshot().groups[0].notes, '旧版电脑修改');
  assert.equal((await localSync.sync()).action, 'unchanged');

  // An explicit empty v2 note is a real change and must not be ignored.
  const nextItem = local.store.snapshot().items[0];
  local.store.put('items', { ...nextItem, fieldNote: '' });
  old.store.put('groups', { ...old.store.snapshot().groups[0], notes: '旧版再修改' });
  assert.equal((await oldSync.sync()).action, 'uploaded');
  assert.equal((await localSync.sync()).action, 'conflict');
  assert.equal(local.store.snapshot().items[0].fieldNote, '');
  assert.equal(local.store.snapshot().groups[0].notes, '旧版电脑修改');
});

test('v1 optional JSON fields survive a pure v3 migration and real edits still conflict', async (t) => {
  const old = fixture(t), local = fixture(t), server = new Server();
  old.store.command({ type: 'demo' });
  const item = old.store.snapshot().items[0];
  old.store.command({ type: 'start', itemId: item.id });
  old.store.command({ type: 'finish', itemId: item.id });
  const run = old.store.snapshot().runs[0];
  const { actualSources: _actualSources, ...v1Run } = run;
  old.store.put('runs', {
    ...v1Run,
    actualSample: { ...run.actualSample, state: '旧版状态', specimenName: '' },
  });
  old.store.put('items', { ...old.store.snapshot().items[0], fieldNote: '旧版测量备注' });
  old.store.db.exec('ALTER TABLE items DROP COLUMN field_note; PRAGMA user_version=1;');
  const currentSnapshot = old.store.snapshot.bind(old.store);
  old.store.snapshot = () => ({ ...currentSnapshot(), schemaVersion: 1 });
  const oldSync = syncFor(old.store, old.directory, server);
  const localSync = syncFor(local.store, local.directory, server);
  assert.equal((await oldSync.sync()).action, 'uploaded');
  const oldPointer = JSON.parse(server.files.get('labrecord/latest.json')!.bytes.toString());
  assert.equal((await localSync.sync()).action, 'downloaded');
  assert.equal(local.store.snapshot().items[0].fieldNote, '旧版测量备注');
  assert.equal(local.store.snapshot().runs[0].actualSample?.state, '旧版状态');
  assert.equal(local.store.snapshot().runs[0].actualSample?.specimenName, '');
  assert.equal((await localSync.sync()).action, 'unchanged');
  assert.equal((await localSync.state())!.digest, oldPointer.digest);
  assert.equal(JSON.parse(server.files.get('labrecord/latest.json')!.bytes.toString()).digest, oldPointer.digest);

  local.store.command({ type: 'updateFieldRow', itemId: item.id, fieldNote: '本机修改' });
  old.store.put('groups', { ...old.store.snapshot().groups[0], notes: '云端修改' });
  assert.equal((await oldSync.sync()).action, 'uploaded');
  assert.equal((await localSync.sync()).action, 'conflict');
  assert.equal(local.store.snapshot().items[0].fieldNote, '本机修改');
  assert.notEqual(local.store.snapshot().groups[0].notes, '云端修改');
});

test('an in-place v1 database upgrade keeps its old cloud baseline until content changes', async (t) => {
  const device = fixture(t),
    remote = fixture(t),
    server = new Server();
  device.store.command({ type: 'demo' });
  device.store.db.exec('ALTER TABLE items DROP COLUMN field_note; PRAGMA user_version=1;');
  const originalSnapshot = device.store.snapshot.bind(device.store);
  device.store.snapshot = () => ({ ...originalSnapshot(), schemaVersion: 1 });
  assert.equal((await syncFor(device.store, device.directory, server).sync()).action, 'uploaded');
  const v1Digest = JSON.parse(server.files.get('labrecord/latest.json')!.bytes.toString()).digest;

  // Opening the real v1 database performs the SQLite migration without touching record JSON.
  device.reopen();
  assert.equal(device.store.snapshot().schemaVersion, 3);
  const upgraded = syncFor(device.store, device.directory, server);
  assert.equal((await upgraded.sync()).action, 'unchanged');
  assert.equal((await upgraded.state())!.digest, v1Digest);

  // A different upgraded computer modifies and uploads a genuine v2 backup.
  const remoteSync = syncFor(remote.store, remote.directory, server);
  assert.equal((await remoteSync.sync()).action, 'downloaded');
  assert.equal((await remoteSync.sync('upload')).action, 'uploaded');
  assert.equal((await upgraded.sync()).action, 'unchanged');
  assert.equal((await upgraded.state())!.digest, snapshotDigest(device.store.snapshot()));
  const remoteGroup = remote.store.snapshot().groups[0];
  remote.store.put('groups', { ...remoteGroup, notes: '远端已更新' });
  assert.equal((await remoteSync.sync()).action, 'uploaded');
  assert.equal((await upgraded.sync()).action, 'downloaded');
  assert.equal(device.store.snapshot().groups[0].notes, '远端已更新');
  assert.equal((await upgraded.sync()).action, 'unchanged');
});

test('new actual-sample fields cannot be treated as a schema-only migration', async (t) => {
  const old = fixture(t),
    local = fixture(t),
    server = new Server();
  old.store.command({ type: 'demo' });
  const item = old.store.snapshot().items[0];
  old.store.command({ type: 'start', itemId: item.id });
  old.store.command({ type: 'finish', itemId: item.id });
  const run = old.store.snapshot().runs[0];
  if (run.actualSample) {
    const { state: _state, specimenName: _specimenName, ...v1Sample } = run.actualSample;
    const { actualSources: _actualSources, ...v1Run } = run;
    old.store.put('runs', { ...v1Run, actualSample: v1Sample });
  }
  old.store.db.exec('ALTER TABLE items DROP COLUMN field_note; PRAGMA user_version=1;');
  const currentSnapshot = old.store.snapshot.bind(old.store);
  old.store.snapshot = () => ({ ...currentSnapshot(), schemaVersion: 1 });
  const oldSync = syncFor(old.store, old.directory, server);
  const localSync = syncFor(local.store, local.directory, server);
  assert.equal((await oldSync.sync()).action, 'uploaded');
  assert.equal((await localSync.sync()).action, 'downloaded');
  const localRun = local.store.snapshot().runs[0];
  assert.ok(localRun.actualSample);
  old.store.put('groups', { ...old.store.snapshot().groups[0], notes: '远端变化' });
  assert.equal((await oldSync.sync()).action, 'uploaded');
  for (const field of ['state', 'specimenName'] as const) {
    local.store.put('runs', {
      ...localRun,
      actualSample: { ...localRun.actualSample, [field]: '' },
      actualSources: { ...localRun.actualSources, [`actualSample.${field}`]: 'edited' },
    });
    assert.equal((await localSync.sync()).action, 'conflict', `${field} is a real v2 edit`);
  }
});

test('v2 sync baseline survives v3 migration but provenance and partial edits remain changes', async (t) => {
  const old = fixture(t), local = fixture(t), server = new Server();
  old.store.command({ type: 'demo' });
  const item = old.store.snapshot().items[0];
  old.store.command({ type: 'start', itemId: item.id });
  old.store.command({ type: 'finish', itemId: item.id });
  const run = old.store.snapshot().runs[0];
  const image = join(old.directory, 'v2-image.png');
  await writeFile(image, PNG);
  const attachment = await addAttachment(old.store, run.id, image);
  const { actualSources: _actualSources, ...v2Run } = run;
  old.store.put('runs', v2Run);
  old.store.db.exec('PRAGMA user_version=2;');
  const currentSnapshot = old.store.snapshot.bind(old.store);
  old.store.snapshot = () => ({ ...currentSnapshot(), schemaVersion: 2 });
  const oldSync = syncFor(old.store, old.directory, server);
  const localSync = syncFor(local.store, local.directory, server);
  assert.equal((await oldSync.sync()).action, 'uploaded');
  const oldDigest = JSON.parse(server.files.get('labrecord/latest.json')!.bytes.toString()).digest;
  assert.equal((await localSync.sync()).action, 'downloaded');
  const migrated = local.store.snapshot().runs[0];
  assert.ok(migrated.actualSample);
  assert.equal(migrated.actualSources?.['actualSample.width'], 'legacy');
  assert.equal((await localSync.sync()).action, 'unchanged');
  assert.equal((await localSync.state())!.digest, oldDigest);
  const backupNames = await readdir(join(local.directory, 'migration-backups'));
  assert.equal(backupNames.length, 1);
  const backupRoot = join(local.directory, 'verified-v2-backup');
  const backedUp = await unpackBackup(join(local.directory, 'migration-backups', backupNames[0]), backupRoot);
  assert.equal(backedUp.schemaVersion, 2);
  assert.deepEqual(await readFile(join(backupRoot, attachment.relativePath)), PNG);

  old.store.put('groups', { ...old.store.snapshot().groups[0], notes: '远端独立修改' });
  assert.equal((await oldSync.sync()).action, 'uploaded');
  for (const source of ['edited', 'planned'] as const) {
    local.store.put('runs', {
      ...migrated,
      actualSources: { ...migrated.actualSources, 'actualSample.width': source },
    });
    assert.equal((await localSync.sync()).action, 'conflict', `${source} provenance is a change`);
  }
  const { width: _width, ...partialSample } = migrated.actualSample;
  const { 'actualSample.width': _widthSource, ...partialSources } = migrated.actualSources!;
  local.store.put('runs', { ...migrated, actualSample: partialSample, actualSources: partialSources });
  assert.equal((await localSync.sync()).action, 'conflict', 'partial v3 detail is not a v2 record');
  local.store.put('runs', {
    ...migrated,
    actualSample: { ...migrated.actualSample, width: '' },
    actualSources: { ...migrated.actualSources, 'actualSample.width': 'edited' },
  });
  assert.equal((await localSync.sync()).action, 'conflict', 'explicitly cleared width is a change');
});

test('a remote pointer digest is verified against the exact backup schema', async (t) => {
  const one = fixture(t),
    two = fixture(t),
    server = new Server();
  one.store.command({ type: 'demo' });
  await syncFor(one.store, one.directory, server).sync();
  const entry = server.files.get('labrecord/latest.json')!;
  const pointer = JSON.parse(entry.bytes.toString());
  pointer.digest = '0'.repeat(64);
  const bytes = Buffer.from(JSON.stringify(pointer));
  server.files.set('labrecord/latest.json', {
    bytes,
    sha: createHash('sha1').update(bytes).digest('hex'),
  });
  await assert.rejects(syncFor(two.store, two.directory, server).sync(), /同步索引不一致/);
  assert.equal(two.store.snapshot().experiments.length, 0);
});

test('multipart backups reassemble records and images; a damaged segment cannot replace local records', async (t) => {
  const one = fixture(t),
    two = fixture(t),
    damaged = fixture(t),
    server = new Server();
  one.store.command({ type: 'demo' });
  one.store.command({ type: 'start', itemId: one.store.snapshot().items[0].id });
  const image = join(one.directory, '现场.png');
  await writeFile(image, PNG);
  await addAttachment(one.store, one.store.snapshot().runs[0].id, image);
  const a = syncFor(one.store, one.directory, server, 1024);
  assert.equal((await a.sync()).action, 'uploaded');
  const pointer = JSON.parse(server.files.get('labrecord/latest.json')!.bytes.toString());
  assert.equal(pointer.file, undefined);
  assert.ok(pointer.chunks.length > 1);
  assert.equal(
    pointer.chunks.reduce((size: number, part: any) => size + part.bytes, 0),
    pointer.bytes,
  );
  assert.equal((await syncFor(two.store, two.directory, server).sync()).action, 'downloaded');
  assert.equal(snapshotDigest(two.store.snapshot()), snapshotDigest(one.store.snapshot()));
  assert.deepEqual(
    await readFile(join(two.store.root, two.store.snapshot().attachments[0].relativePath)),
    PNG,
  );
  server.files.get('labrecord/' + pointer.chunks[1].file)!.bytes[0] ^= 255;
  await assert.rejects(syncFor(damaged.store, damaged.directory, server).sync(), /分段哈希/);
  assert.equal(damaged.store.snapshot().experiments.length, 0);
});
test('private cloud round trip retains dimensions, open records, custom data and image bytes; divergent computers require explicit choice', async (t) => {
  const one = fixture(t),
    two = fixture(t),
    server = new Server();
  one.store.command({ type: 'demo' });
  const before = one.store.snapshot();
  one.store.command({
    type: 'updateGroups',
    ids: [before.groups[0].id],
    patch: { name: 'Ti2448 试样', width: '3.1', dimensionUnit: 'mm' },
  });
  one.store.command({ type: 'start', itemId: before.items[0].id });
  const image = join(one.directory, '照片.png');
  await writeFile(image, PNG);
  await addAttachment(one.store, one.store.snapshot().runs[0].id, image);
  const a = syncFor(one.store, one.directory, server),
    b = syncFor(two.store, two.directory, server);
  assert.equal((await a.sync()).action, 'uploaded');
  assert.equal((await a.sync()).action, 'unchanged');
  assert.equal((await b.sync()).action, 'downloaded');
  assert.equal(two.store.snapshot().groups[0].name, 'Ti2448 试样');
  assert.equal(two.store.snapshot().runs[0].endedAt, null);
  assert.deepEqual(
    await readFile(join(two.store.root, two.store.snapshot().attachments[0].relativePath)),
    PNG,
  );
  one.store.command({
    type: 'saveRun',
    runId: one.store.snapshot().runs[0].id,
    notes: '电脑一的变化',
  });
  two.store.command({
    type: 'saveRun',
    runId: two.store.snapshot().runs[0].id,
    notes: '电脑二的变化',
  });
  await a.sync();
  const result = await b.sync();
  assert.equal(result.action, 'conflict');
  assert.equal(two.store.snapshot().runs[0].notes, '电脑二的变化');
  await assert.rejects(b.sync('download'), /进行中/);
  const history = server.files.size;
  assert.equal((await b.sync('upload')).action, 'uploaded');
  assert.equal(server.files.size, history + 1, 'previous backup remains in cloud history');
});
test('public repository and corrupted remote package are refused before local replacement', async (t) => {
  const one = fixture(t),
    two = fixture(t),
    server = new Server();
  one.store.command({ type: 'demo' });
  const a = syncFor(one.store, one.directory, server),
    b = syncFor(two.store, two.directory, server);
  server.privateRepo = false;
  await assert.rejects(a.sync(), /私人仓库/);
  assert.equal(server.files.size, 0);
  server.privateRepo = true;
  await a.sync();
  const pointer = JSON.parse(server.files.get('labrecord/latest.json')!.bytes.toString());
  server.files.get('labrecord/' + pointer.file)!.bytes[0] ^= 255;
  await assert.rejects(b.sync(), /哈希/);
  assert.equal(two.store.snapshot().experiments.length, 0);
  assert.equal(await b.state(), null);
});
test('concurrent pointer changes do not overwrite latest or advance the local baseline', async (t) => {
  const { store, directory } = fixture(t),
    server = new Server();
  store.command({ type: 'demo' });
  const sync = syncFor(store, directory, server);
  await sync.sync();
  const baseline = await readFile(join(directory, 'cloud-state.json'), 'utf8');
  store.command({
    type: 'updateGroups',
    ids: [store.snapshot().groups[0].id],
    patch: { notes: '本机变化' },
  });
  let concurrent: Buffer;
  server.beforePut = () => {
    const pointer = JSON.parse(server.files.get('labrecord/latest.json')!.bytes.toString());
    pointer.updatedAt = '2026-10-06T12:00:00.000Z';
    concurrent = Buffer.from(JSON.stringify(pointer));
    server.files.set('labrecord/latest.json', {
      bytes: concurrent,
      sha: createHash('sha1').update(concurrent).digest('hex'),
    });
  };
  await assert.rejects(sync.sync(), /云端在同步期间/);
  assert.deepEqual(server.files.get('labrecord/latest.json')!.bytes, concurrent!);
  assert.equal(await readFile(join(directory, 'cloud-state.json'), 'utf8'), baseline);
  assert.equal(store.snapshot().groups[0].notes, '本机变化');
});

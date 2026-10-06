import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fixture, PNG } from './helpers.js';
import {
  CloudSync,
  GithubClient,
  syncDirection,
  snapshotDigest,
} from '../src/desktop/github-sync.js';
import { addAttachment, inspectDatabase } from '../src/desktop/backups.js';
import type { Store } from '../src/desktop/store.js';

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
      const snapshot = inspectDatabase(join(staging, 'records.sqlite'));
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

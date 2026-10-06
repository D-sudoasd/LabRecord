import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { fixture, PNG } from './helpers.js';
import { writeReportBundle } from '../src/desktop/reports.js';
import { addAttachment } from '../src/desktop/backups.js';
import { ReportArchive, ReportQueue } from '../src/desktop/report-archive.js';
import { GithubClient, GithubError } from '../src/desktop/github-sync.js';

class GitServer extends GithubClient {
  privateRepo = true;
  offline = false;
  blobs = new Map<string, Buffer>();
  trees = new Map<string, Map<string, Buffer>>();
  commits = new Map<string, { tree: string; parent: string }>();
  head = '0'.repeat(40);
  counter = 0;
  beforePatch: (() => Promise<void>) | null = null;
  gate: Promise<void> | null = null;
  constructor() {
    super('synthetic-test-token');
    this.trees.set(
      this.head,
      new Map([['labrecord/latest.json', Buffer.from('existing backup pointer')]]),
    );
    this.commits.set(this.head, { tree: this.head, parent: '' });
  }
  files() {
    return this.trees.get(this.commits.get(this.head)!.tree)!;
  }
  next() {
    return (++this.counter).toString(16).padStart(40, '0');
  }
  override async request(path: string, method = 'GET', body?: any, raw = false): Promise<any> {
    if (this.offline) throw new Error('离线测试：无法连接');
    const url = new URL('https://api.github.com' + path),
      p = url.pathname;
    if (p === '/repos/me/lab') return { private: this.privateRepo, default_branch: 'main' };
    if (p.includes('/contents/')) {
      const name = p.split('/contents/')[1],
        ref = url.searchParams.get('ref') || this.head;
      const bytes = this.trees.get(this.commits.get(ref)!.tree)!.get(name);
      if (!bytes) throw new GithubError(404, 'missing');
      assert.equal(raw, true);
      return Buffer.from(bytes);
    }
    if (p.endsWith('/git/blobs') && method === 'POST') {
      if (this.gate) await this.gate;
      const bytes = Buffer.from(body.content, 'base64'),
        sha = createHash('sha1').update(bytes).digest('hex');
      this.blobs.set(sha, bytes);
      return { sha };
    }
    if (p.endsWith('/git/ref/heads/main')) return { object: { sha: this.head } };
    if (p.includes('/git/commits/') && method === 'GET')
      return { tree: { sha: this.commits.get(p.split('/').at(-1)!)!.tree } };
    if (p.endsWith('/git/trees') && method === 'POST') {
      const tree = new Map(this.trees.get(body.base_tree));
      for (const file of body.tree) tree.set(file.path, this.blobs.get(file.sha)!);
      const sha = this.next();
      this.trees.set(sha, tree);
      return { sha };
    }
    if (p.endsWith('/git/commits') && method === 'POST') {
      const sha = this.next();
      this.commits.set(sha, { tree: body.tree, parent: body.parents[0] });
      return { sha };
    }
    if (p.endsWith('/git/refs/heads/main') && method === 'PATCH') {
      assert.equal(body.force, false);
      if (this.beforePatch) {
        const hook = this.beforePatch;
        this.beforePatch = null;
        await hook();
      }
      if (this.commits.get(body.sha)!.parent !== this.head)
        throw new GithubError(409, 'concurrent change');
      this.head = body.sha;
      return {};
    }
    throw new Error('unexpected API: ' + method + ' ' + p);
  }
}
async function bundle(t: Parameters<typeof fixture>[0]) {
  const f = fixture(t);
  f.store.command({ type: 'demo' });
  const experiment = f.store.snapshot().experiments[0];
  f.store.command({ type: 'start', itemId: f.store.snapshot().items[0].id });
  const photo = join(f.directory, '照片.png');
  await writeFile(photo, PNG);
  await addAttachment(f.store, f.store.snapshot().runs[0].id, photo);
  const path = await writeReportBundle(
    f.store.snapshot(),
    experiment.id,
    f.store.root,
    f.directory,
    async () => Buffer.from('%PDF-1.7\nsynthetic core test only'),
  );
  const manifest = JSON.parse(await readFile(join(path, 'manifest.json'), 'utf8'));
  return {
    ...f,
    path,
    meta: {
      id: randomUUID(),
      experimentId: experiment.id,
      experimentName: experiment.name,
      code: experiment.code,
      generatedAt: manifest.generatedAt,
    },
  };
}

test('report files and index publish atomically, keep backups, and retry the same ID without duplicates', async (t) => {
  const b = await bundle(t),
    server = new GitServer(),
    archive = new ReportArchive(server, 'me/lab');
  await archive.publish(b.path, b.meta);
  const head = server.head;
  assert.equal((await archive.list()).length, 1);
  await archive.publish(b.path, b.meta);
  assert.equal(server.head, head);
  assert.equal(server.files().get('labrecord/latest.json')!.toString(), 'existing backup pointer');
  const downloaded = await archive.download(b.meta.id, b.directory);
  const original = JSON.parse(await readFile(join(b.path, 'manifest.json'), 'utf8'));
  for (const file of original.files)
    assert.deepEqual(
      await readFile(join(downloaded, file.path)),
      await readFile(join(b.path, file.path)),
    );
});

test('multipart report preserves Chinese, nulls and image bytes; corrupt cloud content cannot publish a download', async (t) => {
  const b = await bundle(t),
    server = new GitServer(),
    archive = new ReportArchive(server, 'me/lab', 'labrecord', 1024);
  await archive.publish(b.path, b.meta);
  const path = `labrecord/reports/${b.meta.experimentId}/${b.meta.id}/archive.json`;
  const manifest = JSON.parse(server.files().get(path)!.toString());
  const multipart = manifest.files.find((f: any) => f.parts.length > 1);
  assert.ok(multipart);
  const folder = await archive.download(b.meta.id, b.directory);
  const records = JSON.parse(await readFile(join(folder, 'records.json'), 'utf8'));
  assert.equal(records.runs[0].endedAt, null);
  assert.equal(records.groups[0].name, 'Ti-A 拉伸试样');
  const photo = manifest.files.find((f: any) => f.path.startsWith('images/'));
  assert.deepEqual(await readFile(join(folder, photo.path)), PNG);
  const before = await readdir(b.directory);
  const partPath = `labrecord/reports/${b.meta.experimentId}/${b.meta.id}/${multipart.parts[0].path}`;
  server.files().get(partPath)![0] ^= 255;
  await assert.rejects(archive.download(b.meta.id, b.directory), /分段校验/);
  assert.deepEqual(await readdir(b.directory), before);
});

test('concurrent device report indexes merge after fast-forward rejection; public repositories refuse writes', async (t) => {
  const a = await bundle(t),
    b = await bundle(t),
    server = new GitServer(),
    archive = new ReportArchive(server, 'me/lab');
  server.privateRepo = false;
  await assert.rejects(archive.publish(a.path, a.meta), /私人仓库/);
  assert.equal(server.blobs.size, 0);
  server.privateRepo = true;
  server.beforePatch = () => archive.publish(b.path, b.meta).then(() => {});
  await archive.publish(a.path, a.meta);
  assert.deepEqual(
    new Set((await archive.list()).map((r) => r.id)),
    new Set([a.meta.id, b.meta.id]),
  );
  assert.equal(server.files().get('labrecord/latest.json')!.toString(), 'existing backup pointer');
});

test('offline report queue survives restart and removed export directory; wrong repository cannot receive pending jobs', async (t) => {
  const b = await bundle(t),
    server = new GitServer(),
    root = join(b.directory, 'report-archive');
  const queue = new ReportQueue(root);
  const job = await queue.enqueue(
    b.path,
    'me/lab',
    'labrecord',
    b.meta.experimentName,
    b.meta.code,
  );
  await rm(b.path, { recursive: true });
  server.offline = true;
  await queue.run(async () => ({ repository: 'me/lab', prefix: 'labrecord', client: server }));
  assert.equal((await queue.list())[0].state, 'failed');
  const restarted = new ReportQueue(root);
  server.offline = false;
  await restarted.run(async () => ({
    repository: 'me/other',
    prefix: 'labrecord',
    client: server,
  }));
  assert.equal((await restarted.list())[0].state, 'failed');
  assert.equal(server.blobs.size, 0);
  await restarted.run(async () => ({ repository: 'me/lab', prefix: 'labrecord', client: server }));
  assert.equal((await restarted.list())[0].state, 'uploaded');
  assert.equal((await new ReportArchive(server, 'me/lab').list())[0].id, job.id);
  const state = await readFile(join(root, 'queue.json'), 'utf8');
  assert.ok(!state.includes('synthetic-test-token'));
});

test('slow background upload does not block local records or status reads, and interrupted uploading resumes', async (t) => {
  const b = await bundle(t),
    server = new GitServer(),
    root = join(b.directory, 'report-archive');
  const queue = new ReportQueue(root);
  await queue.enqueue(b.path, 'me/lab', 'labrecord', b.meta.experimentName, b.meta.code);
  let release!: () => void;
  server.gate = new Promise<void>((r) => {
    release = r;
  });
  const running = queue.run(async () => ({
    repository: 'me/lab',
    prefix: 'labrecord',
    client: server,
  }));
  for (let i = 0; (await queue.list())[0].state !== 'uploading' && i < 20; i++)
    await new Promise((r) => setTimeout(r, 10));
  assert.equal((await queue.list())[0].state, 'uploading');
  b.store.command({
    type: 'saveRun',
    runId: b.store.snapshot().runs[0].id,
    notes: '上传时继续记录',
  });
  b.store.command({ type: 'finish', itemId: b.store.snapshot().items[0].id });
  assert.equal(b.store.snapshot().runs[0].notes, '上传时继续记录');
  assert.ok(b.store.snapshot().runs[0].endedAt);
  release();
  await running;
  const stored = JSON.parse(await readFile(join(root, 'queue.json'), 'utf8'));
  stored.jobs[0].state = 'uploading';
  await writeFile(join(root, 'queue.json'), JSON.stringify(stored));
  assert.equal((await new ReportQueue(root).list())[0].state, 'pending');
});

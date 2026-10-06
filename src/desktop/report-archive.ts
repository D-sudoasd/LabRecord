import { readFile, writeFile, mkdir, copyFile, rename, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { GithubClient, GithubError, repositorySchema } from './github-sync.js';
import { hashBytes } from './reports.js';
import type { CloudReport, ReportJob } from '../shared/model.js';

const CHUNK = 20 * 1024 * 1024;
const DIRECT = 20 * 1024 * 1024;
const MAX_TOTAL = 2 * 1024 ** 3;
const id = z.string().uuid();
const checksum = z.string().regex(/^[a-f0-9]{64}$/);
const filePath = z
  .string()
  .regex(
    /^(report\.(pdf|html)|records\.json|README-agent\.md|manifest\.json|images\/[a-f0-9-]{36}\.(png|jpe?g|webp|gif))$/,
  );
const descriptor = z
  .object({
    path: filePath,
    bytes: z.number().int().nonnegative().max(MAX_TOTAL),
    sha256: checksum,
  })
  .strict();
const sourceManifest = z
  .object({
    format: z.literal('LabRecordReport'),
    formatVersion: z.literal(1),
    experimentId: id,
    generatedAt: z.string().datetime(),
    files: z.array(descriptor).min(4).max(10004),
  })
  .passthrough();
const metadata = z
  .object({
    id,
    experimentId: id,
    experimentName: z.string().max(500),
    code: z.string().max(500),
    generatedAt: z.string().datetime(),
  })
  .strict();
const entry = metadata
  .extend({ manifestSha256: checksum, multipartFiles: z.array(filePath).max(10005).optional() })
  .strict();
const indexSchema = z
  .object({
    format: z.literal('LabRecordReports'),
    version: z.literal(1),
    reports: z.array(entry).max(10000),
  })
  .strict();
const archiveSchema = metadata
  .extend({
    format: z.literal('LabRecordReportArchive'),
    version: z.literal(1),
    files: z
      .array(
        descriptor
          .extend({
            parts: z
              .array(
                z
                  .object({
                    path: z.string(),
                    bytes: z.number().int().nonnegative().max(CHUNK),
                    sha256: checksum,
                  })
                  .strict(),
              )
              .min(1)
              .max(103),
          })
          .strict(),
      )
      .min(5)
      .max(10005),
  })
  .strict();
type Archive = z.infer<typeof archiveSchema>;
type Metadata = z.infer<typeof metadata>;
type Entry = z.infer<typeof entry>;
const jobSchema = metadata
  .extend({
    repository: repositorySchema,
    prefix: z.string().regex(/^[a-z0-9-]+$/),
    localPath: z.string(),
    state: z.enum(['pending', 'uploading', 'uploaded', 'failed']),
    error: z.string().nullable(),
  })
  .strict();
const queueSchema = z
  .object({
    format: z.literal('LabRecordReportQueue'),
    version: z.literal(1),
    jobs: z.array(jobSchema).max(10000),
  })
  .strict();
function json(value: unknown) {
  return Buffer.from(JSON.stringify(value, null, 2) + '\n');
}
function verifyFiles(files: { path: string; bytes: number }[]) {
  const paths = files.map((f) => f.path);
  if (new Set(paths).size !== paths.length || files.reduce((n, f) => n + f.bytes, 0) > MAX_TOTAL)
    throw new Error('报告清单重复或报告超过 2 GiB，已保留本机报告。');
  for (const required of [
    'report.pdf',
    'report.html',
    'records.json',
    'README-agent.md',
    'manifest.json',
  ])
    if (!paths.includes(required)) throw new Error('报告文件不完整：' + required);
}
async function verifiedBundle(directory: string) {
  const bytes = await readFile(join(directory, 'manifest.json'));
  const manifest = sourceManifest.parse(JSON.parse(bytes.toString()));
  const files = [
    ...manifest.files,
    { path: 'manifest.json', bytes: bytes.length, sha256: hashBytes(bytes) },
  ];
  verifyFiles(files);
  for (const file of files) {
    const content = await readFile(join(directory, file.path));
    if (content.length !== file.bytes || hashBytes(content) !== file.sha256)
      throw new Error('报告文件校验失败：' + file.path);
  }
  return { manifest, files };
}
function verifyArchive(value: unknown): Archive {
  const archive = archiveSchema.parse(value);
  verifyFiles(archive.files);
  for (const file of archive.files) {
    if (file.parts.reduce((n, p) => n + p.bytes, 0) !== file.bytes)
      throw new Error('报告分段大小无效。');
    file.parts.forEach((part, i) => {
      const expected =
        file.parts.length === 1 ? file.path : `${file.path}.part-${String(i).padStart(3, '0')}`;
      if (part.path !== expected) throw new Error('报告分段路径无效。');
    });
  }
  return archive;
}
const label = (text: string) => text.replace(/[\r\n\[\]<>`\\|]/g, ' ');
function indexMarkdown(reports: Entry[]) {
  return (
    '# 私人实验报告\n\n完整实验恢复使用 ../latest.json 对应的备份；本目录用于阅读报告与后续分析。HTML 下载后离线打开；JSON 明细包含稳定 ID、单位、空值和修改历史。仪器原始数据另行保存。\n\n' +
    reports
      .map((r) => {
        const link = (name: string, file: string) =>
          r.multipartFiles?.includes(file)
            ? `${name}（分段，请使用软件下载）`
            : `[${name}](${r.experimentId}/${r.id}/${file})`;
        return `- ${link(label(r.code) + ' · ' + label(r.experimentName), 'README-agent.md')} · ${r.generatedAt}\n  ${link('PDF', 'report.pdf')} · ${link('HTML', 'report.html')} · ${link('JSON', 'records.json')} · [下载清单](${r.experimentId}/${r.id}/archive.json)`;
      })
      .join('\n')
  );
}

export class ReportArchive {
  constructor(
    readonly client: GithubClient,
    readonly repository: string,
    readonly prefix = 'labrecord',
    readonly chunkBytes = CHUNK,
  ) {
    repositorySchema.parse(repository);
    if (
      !/^[a-z0-9-]+$/.test(prefix) ||
      !Number.isInteger(chunkBytes) ||
      chunkBytes < 1 ||
      chunkBytes > CHUNK
    )
      throw new Error('报告归档配置无效。');
  }
  private base() {
    return `${this.prefix}/reports`;
  }
  private folder(report: Metadata) {
    return `${this.base()}/${report.experimentId}/${report.id}`;
  }
  private async readJson(path: string, ref?: string) {
    try {
      const bytes: Buffer = await this.client.request(
        `/repos/${this.repository}/contents/${path}${ref ? '?ref=' + encodeURIComponent(ref) : ''}`,
        'GET',
        undefined,
        true,
      );
      return { value: JSON.parse(bytes.toString()), sha256: hashBytes(bytes) };
    } catch (error) {
      if (error instanceof GithubError && error.status === 404) return null;
      throw error;
    }
  }
  private async readIndex(ref?: string) {
    const result = await this.readJson(`${this.base()}/index.json`, ref);
    const index = result
      ? indexSchema.parse(result.value)
      : { format: 'LabRecordReports' as const, version: 1 as const, reports: [] as Entry[] };
    if (new Set(index.reports.map((r) => r.id)).size !== index.reports.length)
      throw new Error('报告索引包含重复 ID。');
    return index;
  }
  async list(): Promise<CloudReport[]> {
    await this.client.verifyPrivate(this.repository);
    return (await this.readIndex()).reports;
  }
  async publish(directory: string, input: Metadata) {
    const info = await this.client.verifyPrivate(this.repository);
    const meta = metadata.parse(input),
      { manifest, files } = await verifiedBundle(directory);
    if (manifest.experimentId !== meta.experimentId || manifest.generatedAt !== meta.generatedAt)
      throw new Error('报告与归档任务不一致。');
    const existing = (await this.readIndex()).reports.find((r) => r.id === meta.id);
    if (existing) {
      const remote = await this.readJson(`${this.folder(meta)}/archive.json`);
      if (!remote || remote.sha256 !== existing.manifestSha256)
        throw new Error('已归档报告清单校验失败。');
      const archived = verifyArchive(remote.value);
      if (JSON.stringify(archived.files.map(({ parts: _, ...f }) => f)) !== JSON.stringify(files))
        throw new Error('报告 ID 已存在且内容不同。');
      return existing;
    }
    const tree: { path: string; mode: string; type: string; sha: string }[] = [];
    const addBlob = async (path: string, content: Buffer) => {
      const blob = await this.client.request(`/repos/${this.repository}/git/blobs`, 'POST', {
        encoding: 'base64',
        content: content.toString('base64'),
      });
      if (typeof blob.sha !== 'string' || !/^[a-f0-9]{40,64}$/.test(blob.sha))
        throw new Error('GitHub 文件响应无效。');
      tree.push({ path, mode: '100644', type: 'blob', sha: blob.sha });
    };
    const archive: Archive = { ...meta, format: 'LabRecordReportArchive', version: 1, files: [] };
    for (const file of files) {
      const content = await readFile(join(directory, file.path));
      if (content.length !== file.bytes || hashBytes(content) !== file.sha256)
        throw new Error('报告在上传前发生变化：' + file.path);
      const multipart = content.length > Math.min(DIRECT, this.chunkBytes),
        parts: Archive['files'][number]['parts'] = [];
      for (
        let offset = 0, n = 0;
        offset < content.length || (n === 0 && !content.length);
        offset += this.chunkBytes, n++
      ) {
        const part = multipart ? content.subarray(offset, offset + this.chunkBytes) : content;
        const path = multipart ? `${file.path}.part-${String(n).padStart(3, '0')}` : file.path;
        await addBlob(`${this.folder(meta)}/${path}`, part);
        parts.push({ path, bytes: part.length, sha256: hashBytes(part) });
        if (!multipart) break;
      }
      archive.files.push({ ...file, parts });
    }
    const bytes = json(archive),
      report = {
        ...meta,
        manifestSha256: hashBytes(bytes),
        multipartFiles: archive.files.filter((f) => f.parts.length > 1).map((f) => f.path),
      };
    await addBlob(`${this.folder(meta)}/archive.json`, bytes);
    // Commit the full report and its index together; never force another device's branch away.
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.client.verifyPrivate(this.repository);
      const head = await this.client.request(
        `/repos/${this.repository}/git/ref/heads/${encodeURIComponent(info.default_branch)}`,
      );
      const commit = await this.client.request(
        `/repos/${this.repository}/git/commits/${head.object.sha}`,
      );
      const index = await this.readIndex(head.object.sha);
      const same = index.reports.find((r) => r.id === report.id);
      if (same) {
        if (same.manifestSha256 !== report.manifestSha256)
          throw new Error('报告 ID 冲突，原云端版本已保留。');
        return same;
      }
      index.reports.push(report);
      index.reports.sort(
        (a, b) => b.generatedAt.localeCompare(a.generatedAt) || a.id.localeCompare(b.id),
      );
      const changed = [...tree];
      for (const [path, content] of [
        [`${this.base()}/index.json`, json(index)],
        [`${this.base()}/README.md`, Buffer.from(indexMarkdown(index.reports))],
      ] as const) {
        const blob = await this.client.request(`/repos/${this.repository}/git/blobs`, 'POST', {
          encoding: 'base64',
          content: content.toString('base64'),
        });
        changed.push({ path, mode: '100644', type: 'blob', sha: blob.sha });
      }
      const newTree = await this.client.request(`/repos/${this.repository}/git/trees`, 'POST', {
        base_tree: commit.tree.sha,
        tree: changed,
      });
      const next = await this.client.request(`/repos/${this.repository}/git/commits`, 'POST', {
        message: 'LabRecord: 归档实验报告',
        tree: newTree.sha,
        parents: [head.object.sha],
      });
      try {
        await this.client.request(
          `/repos/${this.repository}/git/refs/heads/${encodeURIComponent(info.default_branch)}`,
          'PATCH',
          { sha: next.sha, force: false },
        );
        return report;
      } catch (error) {
        if (!(error instanceof GithubError) || ![409, 422].includes(error.status) || attempt === 2)
          throw error;
      }
    }
    throw new Error('云端持续变化，请重试；本机报告已保留。');
  }
  async download(reportId: string, parent: string): Promise<string> {
    id.parse(reportId);
    const report = (await this.list()).find((r) => r.id === reportId);
    if (!report) throw new Error('云端报告不存在。');
    const remote = await this.readJson(`${this.folder(report)}/archive.json`);
    if (!remote || remote.sha256 !== report.manifestSha256)
      throw new Error('云端报告清单哈希不一致。');
    const archive = verifyArchive(remote.value);
    if (archive.id !== report.id || archive.experimentId !== report.experimentId)
      throw new Error('云端报告身份不一致。');
    const nonce = randomUUID(),
      staging = join(parent, 'LabRecord-download-' + nonce),
      target = join(parent, 'LabRecord-报告-' + reportId + '-' + nonce.slice(0, 8));
    await mkdir(staging, { recursive: true });
    try {
      for (const file of archive.files) {
        const pieces: Buffer[] = [];
        for (const part of file.parts) {
          const content: Buffer = await this.client.request(
            `/repos/${this.repository}/contents/${this.folder(report)}/${part.path}`,
            'GET',
            undefined,
            true,
          );
          if (content.length !== part.bytes || hashBytes(content) !== part.sha256)
            throw new Error('云端报告分段校验失败：' + part.path);
          pieces.push(content);
        }
        const content = Buffer.concat(pieces);
        if (content.length !== file.bytes || hashBytes(content) !== file.sha256)
          throw new Error('云端报告文件校验失败：' + file.path);
        await mkdir(join(staging, file.path, '..'), { recursive: true });
        await writeFile(join(staging, file.path), content);
      }
      await verifiedBundle(staging);
      await rename(staging, target);
      return target;
    } finally {
      if (!resolve(staging).startsWith(resolve(parent) + sep) || !staging.endsWith(nonce))
        throw new Error('报告下载临时路径无效。');
      await rm(staging, { recursive: true, force: true });
    }
  }
}

export class ReportQueue {
  private serial: Promise<unknown> = Promise.resolve();
  private worker: Promise<void> | null = null;
  private initialized = false;
  constructor(readonly root: string) {}
  private async jobs() {
    try {
      return queueSchema.parse(JSON.parse(await readFile(join(this.root, 'queue.json'), 'utf8')))
        .jobs;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new Error('报告归档队列读取失败，本机报告仍保留。');
    }
  }
  private async mutate<T>(action: (jobs: ReportJob[]) => Promise<T>) {
    const run = this.serial.then(async () => {
      const jobs = await this.jobs();
      if (!this.initialized) {
        jobs.forEach((j) => {
          if (j.state === 'uploading') j.state = 'pending';
        });
        this.initialized = true;
      }
      const value = await action(jobs);
      await mkdir(this.root, { recursive: true });
      await writeFile(
        join(this.root, 'queue.json.tmp'),
        json({ format: 'LabRecordReportQueue', version: 1, jobs }),
      );
      await rename(join(this.root, 'queue.json.tmp'), join(this.root, 'queue.json'));
      return value;
    });
    this.serial = run.catch(() => {});
    return run;
  }
  async list(): Promise<ReportJob[]> {
    if (!this.initialized) return this.mutate(async (jobs) => structuredClone(jobs));
    await this.serial;
    return structuredClone(await this.jobs());
  }
  async failWaiting(repository: string, prefix: string, error: string) {
    await this.mutate(async (jobs) => {
      for (const job of jobs)
        if (
          job.state !== 'uploaded' &&
          job.repository.toLowerCase() === repository.toLowerCase() &&
          job.prefix === prefix
        ) {
          job.state = 'failed';
          job.error = error;
        }
    });
  }
  async enqueue(
    directory: string,
    repository: string,
    prefix: string,
    experimentName: string,
    code: string,
  ) {
    const { manifest, files } = await verifiedBundle(directory),
      reportId = randomUUID();
    const job = jobSchema.parse({
      id: reportId,
      experimentId: manifest.experimentId,
      experimentName,
      code,
      generatedAt: manifest.generatedAt,
      repository,
      prefix,
      localPath: directory,
      state: 'pending',
      error: null,
    });
    const cache = join(this.root, reportId);
    await mkdir(cache, { recursive: true });
    for (const file of files) {
      await mkdir(join(cache, file.path, '..'), { recursive: true });
      await copyFile(join(directory, file.path), join(cache, file.path));
    }
    await verifiedBundle(cache);
    await this.mutate(async (jobs) => {
      jobs.push(job);
    });
    return job;
  }
  run(
    connection: () => Promise<{ repository: string; prefix: string; client: GithubClient } | null>,
  ): Promise<void> {
    if (this.worker) return this.worker;
    this.worker = (async () => {
      const attempted = new Set<string>();
      while (true) {
        const session = await connection();
        if (!session) return;
        const job = await this.mutate(async (jobs) => {
          const next = jobs.find(
            (j) =>
              j.state !== 'uploaded' &&
              !attempted.has(j.id) &&
              j.repository.toLowerCase() === session.repository.toLowerCase() &&
              j.prefix === session.prefix,
          );
          if (next) {
            next.state = 'uploading';
            next.error = null;
          }
          return next ? structuredClone(next) : null;
        });
        if (!job) return;
        attempted.add(job.id);
        try {
          await new ReportArchive(session.client, job.repository, job.prefix).publish(
            join(this.root, job.id),
            metadata.parse({
              id: job.id,
              experimentId: job.experimentId,
              experimentName: job.experimentName,
              code: job.code,
              generatedAt: job.generatedAt,
            }),
          );
          await this.mutate(async (jobs) => {
            const saved = jobs.find((j) => j.id === job.id)!;
            saved.state = 'uploaded';
            saved.error = null;
          });
          await rm(join(this.root, job.id), { recursive: true, force: true });
        } catch (error) {
          await this.mutate(async (jobs) => {
            const saved = jobs.find((j) => j.id === job.id)!;
            saved.state = 'failed';
            saved.error = error instanceof Error ? error.message : '报告上传失败，请重试。';
          });
        }
      }
    })().finally(() => {
      this.worker = null;
    });
    return this.worker;
  }
}

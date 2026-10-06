import { readFile, writeFile, appendFile, rename, mkdir, rm, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import type { Snapshot, CloudResult, CloudSummary } from '../shared/model.js';
import { createBackup, unpackBackup } from './backups.js';
import type { Store } from './store.js';
import { hashBytes } from './reports.js';

const MAX_CLOUD_BYTES = 45 * 1024 * 1024;
const CHUNK_BYTES = 20 * 1024 * 1024;
const MAX_BACKUP_BYTES = 512 * 1024 * 1024;
const checksumSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const repositorySchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/)
  .refine((value) => !value.endsWith('/.') && !value.endsWith('/..'));
const summarySchema = z.object({
  experiments: z.number().int().nonnegative(),
  operations: z.number().int().nonnegative(),
  recorded: z.number().int().nonnegative(),
  images: z.number().int().nonnegative(),
});
const pointerSchema = z
  .object({
    format: z.literal('LabRecordSync'),
    version: z.literal(1),
    digest: checksumSchema,
    file: z
      .string()
      .regex(/^snapshots\/[a-f0-9-]{36}\.labrecord$/)
      .optional(),
    chunks: z
      .array(
        z
          .object({
            file: z.string().regex(/^snapshots\/[a-f0-9-]{36}-\d{3}\.part$/),
            bytes: z.number().int().positive().max(CHUNK_BYTES),
            sha256: checksumSchema,
          })
          .strict(),
      )
      .min(1)
      .max(26)
      .optional(),
    sha256: checksumSchema,
    bytes: z.number().int().positive().max(MAX_BACKUP_BYTES),
    updatedAt: z.string().datetime(),
    summary: summarySchema,
  })
  .strict()
  .refine(
    (value) => Boolean(value.file) !== Boolean(value.chunks),
    '备份文件与分段索引必须二选一。',
  )
  .refine(
    (value) =>
      value.chunks
        ? value.chunks.reduce((sum, chunk) => sum + chunk.bytes, 0) === value.bytes &&
          new Set(value.chunks.map((chunk) => chunk.file)).size === value.chunks.length
        : value.bytes <= MAX_CLOUD_BYTES,
    '备份大小或分段索引无效。',
  );
type Pointer = z.infer<typeof pointerSchema>;
type State = { repository: string; prefix: string; digest: string; lastSyncedAt: string };
export class GithubError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
export class GithubClient {
  constructor(
    private readonly token: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}
  async request(path: string, method = 'GET', body?: unknown, raw = false): Promise<any> {
    if (!path.startsWith('/') || path.startsWith('//')) throw new Error('GitHub 请求路径无效。');
    const response = await this.fetcher(`https://api.github.com${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2026-03-10',
        'Content-Type': 'application/json',
        'User-Agent': 'LabRecord',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(120000),
    });
    if (!response.ok) {
      const labels: Record<number, string> = {
        401: 'GitHub 登录已失效，请重新连接。',
        403: 'GitHub 权限不足或请求额度已用完，请核对令牌权限。',
        404: '私人仓库或同步文件不存在，或当前账号无权访问。',
        409: '云端在同步期间发生变化，本机记录已保留，请重新同步。',
        422: '云端文件已发生变化或仓库设置不允许写入，请重新同步。',
      };
      throw new GithubError(
        response.status,
        labels[response.status] || `GitHub 请求失败（${response.status}），请稍后重试。`,
      );
    }
    if (!raw) return response.status === 204 ? null : response.json();
    if (Number(response.headers.get('content-length') || 0) > MAX_CLOUD_BYTES)
      throw new Error('云端单个同步文件超过 45 MiB，索引或分段格式无效。');
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (!response.body) throw new Error('云端备份内容为空。');
    for await (const chunk of response.body as any) {
      size += chunk.length;
      if (size > MAX_CLOUD_BYTES) {
        await response.body.cancel().catch(() => {});
        throw new Error('云端单个同步文件超过 45 MiB。');
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
  async verifyPrivate(repository: string) {
    repositorySchema.parse(repository);
    const info = await this.request(`/repos/${repository}`);
    if (info.private !== true)
      throw new Error('实验数据同步必须使用 GitHub 私人仓库，请选择或新建私人仓库。');
    if (info.archived || info.disabled) throw new Error('此仓库已归档或停用。');
    return info;
  }
  async connect(repository: string, create = false) {
    repositorySchema.parse(repository);
    const user = await this.request('/user');
    try {
      await this.verifyPrivate(repository);
    } catch (error) {
      if (!(error instanceof GithubError) || error.status !== 404 || !create) throw error;
      const [owner, name] = repository.split('/');
      if (owner.toLowerCase() !== String(user.login).toLowerCase())
        throw new Error('只能在当前登录账号下新建私人仓库；已有仓库可直接连接。');
      await this.request('/user/repos', 'POST', {
        name,
        private: true,
        auto_init: true,
        description: 'LabRecord 私人实验数据同步，包含记录与图片备份。',
      });
      await this.verifyPrivate(repository);
    }
    return String(user.login);
  }
  async getFile(
    repository: string,
    path: string,
  ): Promise<{ content: Buffer; sha: string } | null> {
    try {
      const result = await this.request(`/repos/${repository}/contents/${path}`);
      if (
        result.type !== 'file' ||
        result.encoding !== 'base64' ||
        result.size > 32768 ||
        typeof result.sha !== 'string'
      )
        throw new Error('云端同步索引格式无效。');
      return { content: Buffer.from(result.content, 'base64'), sha: result.sha };
    } catch (error) {
      if (error instanceof GithubError && error.status === 404) return null;
      throw error;
    }
  }
  async putFile(repository: string, path: string, content: Buffer, sha?: string) {
    return this.request(`/repos/${repository}/contents/${path}`, 'PUT', {
      message: `LabRecord: ${path.endsWith('latest.json') ? '更新同步索引' : '保存完整实验快照'}`,
      content: content.toString('base64'),
      ...(sha ? { sha } : {}),
    });
  }
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, v]) => [key, canonical(v)]),
    );
  return value;
}
export function snapshotDigest(snapshot: Snapshot) {
  const sorted = Object.fromEntries(
    Object.entries(snapshot).map(([key, value]) => [
      key,
      Array.isArray(value) ? [...value].sort((a, b) => a.id.localeCompare(b.id)) : value,
    ]),
  );
  return hashBytes(JSON.stringify(canonical(sorted)));
}
export function cloudSummary(snapshot: Snapshot): CloudSummary {
  return {
    experiments: snapshot.experiments.length,
    operations: snapshot.items.length,
    recorded: snapshot.runs.length,
    images: snapshot.attachments.length,
  };
}
export function syncDirection(
  local: string,
  remote: string | null,
  baseline: string | null,
  localEmpty: boolean,
): 'upload' | 'download' | 'unchanged' | 'conflict' {
  if (!remote) return 'upload';
  if (local === remote) return 'unchanged';
  if (localEmpty && !baseline) return 'download';
  if (baseline && remote === baseline) return 'upload';
  if (baseline && local === baseline) return 'download';
  return 'conflict';
}
export class CloudSync {
  constructor(
    readonly options: {
      repository: string;
      client: GithubClient;
      statePath: string;
      temporaryRoot: string;
      getStore: () => Store;
      install: (staging: string) => Promise<Snapshot>;
      prefix?: string;
      /** A smaller chunk size lets tests exercise real multipart transfers with small fixtures. */
      chunkBytes?: number;
    },
  ) {
    repositorySchema.parse(options.repository);
    if (!/^[a-z0-9-]+$/.test(options.prefix || 'labrecord')) throw new Error('同步目录无效。');
    if (
      options.chunkBytes !== undefined &&
      (!Number.isInteger(options.chunkBytes) ||
        options.chunkBytes < 1 ||
        options.chunkBytes > CHUNK_BYTES)
    )
      throw new Error('同步分段大小无效。');
  }
  async state(): Promise<State | null> {
    try {
      return z
        .object({
          repository: repositorySchema,
          prefix: z.string(),
          digest: z.string().regex(/^[a-f0-9]{64}$/),
          lastSyncedAt: z.string().datetime(),
        })
        .parse(JSON.parse(await readFile(this.options.statePath, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new Error('本机同步状态读取失败，请检查数据目录。');
    }
  }
  private async remember(digest: string) {
    const value: State = {
      repository: this.options.repository,
      prefix: this.options.prefix || 'labrecord',
      digest,
      lastSyncedAt: new Date().toISOString(),
    };
    await mkdir(join(this.options.statePath, '..'), { recursive: true });
    const temp = this.options.statePath + '.tmp';
    await writeFile(temp, JSON.stringify(value));
    await rename(temp, this.options.statePath);
  }
  async sync(mode: 'auto' | 'upload' | 'download' = 'auto'): Promise<CloudResult> {
    const { repository, client, getStore, temporaryRoot, install } = this.options;
    const prefix = this.options.prefix || 'labrecord';
    await client.verifyPrivate(repository);
    const localSnapshot = getStore().snapshot(),
      local = cloudSummary(localSnapshot),
      digest = snapshotDigest(localSnapshot);
    const file = await client.getFile(repository, `${prefix}/latest.json`);
    const pointer = file ? pointerSchema.parse(JSON.parse(file.content.toString('utf8'))) : null;
    const remembered = await this.state();
    const baseline =
      remembered?.repository.toLowerCase() === repository.toLowerCase() &&
      remembered.prefix === prefix
        ? remembered.digest
        : null;
    const direction =
      mode === 'auto'
        ? syncDirection(
            digest,
            pointer?.digest || null,
            baseline,
            localSnapshot.experiments.length === 0,
          )
        : mode;
    if (direction === 'conflict')
      return {
        action: 'conflict',
        local,
        remote: pointer!.summary,
        message: '本机和云端都有独立修改。选择要继续使用的一份，另一份会保留为备份或云端历史。',
      };
    if (direction === 'unchanged') {
      await this.remember(digest);
      return {
        action: 'unchanged',
        local,
        remote: pointer!.summary,
        message: '本机与云端记录一致。',
      };
    }
    const temporary = join(temporaryRoot, `sync-${randomUUID()}`);
    await mkdir(temporary, { recursive: true });
    try {
      if (direction === 'upload') {
        const path = join(temporary, 'upload.labrecord');
        await createBackup(getStore(), path);
        const size = (await stat(path)).size;
        if (size > MAX_BACKUP_BYTES)
          throw new Error('完整备份超过 512 MiB，请分开保存实验和现场图片后重试。');
        const chunkBytes = this.options.chunkBytes || CHUNK_BYTES;
        const snapshotId = randomUUID();
        const payload: Pick<Pointer, 'file' | 'chunks' | 'sha256'> = { sha256: '' };
        if (size <= chunkBytes) {
          const bytes = await readFile(path);
          payload.file = `snapshots/${snapshotId}.labrecord`;
          payload.sha256 = hashBytes(bytes);
          await client.putFile(repository, `${prefix}/${payload.file}`, bytes);
        } else {
          payload.chunks = [];
          const hash = createHash('sha256');
          for await (const part of createReadStream(path, { highWaterMark: chunkBytes })) {
            const bytes = part as Buffer;
            hash.update(bytes);
            const name = `snapshots/${snapshotId}-${String(payload.chunks.length + 1).padStart(3, '0')}.part`;
            await client.putFile(repository, `${prefix}/${name}`, bytes);
            payload.chunks.push({ file: name, bytes: bytes.length, sha256: hashBytes(bytes) });
          }
          payload.sha256 = hash.digest('hex');
        }
        // A concurrent uploader may leave this snapshot in history, but cannot replace latest without its SHA.
        const next: Pointer = {
          format: 'LabRecordSync',
          version: 1,
          digest,
          ...payload,
          bytes: size,
          updatedAt: new Date().toISOString(),
          summary: local,
        };
        pointerSchema.parse(next);
        await client.putFile(
          repository,
          `${prefix}/latest.json`,
          Buffer.from(JSON.stringify(next, null, 2)),
          file?.sha,
        );
        await this.remember(digest);
        return {
          action: 'uploaded',
          local,
          remote: local,
          message: `已上传 ${local.experiments} 个实验及 ${local.images} 张图片，其他电脑可以接收。`,
        };
      }
      if (!pointer) throw new Error('云端尚无实验记录，请先上传。');
      if (localSnapshot.items.some((item) => item.status === 'running'))
        throw new Error('本机还有进行中的操作，请先完成或中断，再接收云端记录。');
      const path = join(temporary, 'download.labrecord'),
        staging = join(temporary, 'workspace');
      await writeFile(path, Buffer.alloc(0));
      const chunks = pointer.chunks || [
        { file: pointer.file!, bytes: pointer.bytes, sha256: pointer.sha256 },
      ];
      const hash = createHash('sha256');
      for (const chunk of chunks) {
        const bytes: Buffer = await client.request(
          `/repos/${repository}/contents/${prefix}/${chunk.file}`,
          'GET',
          undefined,
          true,
        );
        if (bytes.length !== chunk.bytes || hashBytes(bytes) !== chunk.sha256)
          throw new Error('云端备份分段哈希校验失败，本机数据保持原状。');
        hash.update(bytes);
        await appendFile(path, bytes);
      }
      if ((await stat(path)).size !== pointer.bytes || hash.digest('hex') !== pointer.sha256)
        throw new Error('云端完整备份哈希校验失败，本机数据保持原状。');
      const checked = await unpackBackup(path, staging);
      if (snapshotDigest(checked) !== pointer.digest)
        throw new Error('云端记录与同步索引不一致，本机数据保持原状。');
      const snapshot = await install(staging);
      await this.remember(pointer.digest);
      return {
        action: 'downloaded',
        local: cloudSummary(snapshot),
        remote: pointer.summary,
        snapshot,
        message: '已接收云端实验记录和图片；接收前的本机记录已保存完整备份。',
      };
    } finally {
      if (
        !resolve(temporary).startsWith(resolve(temporaryRoot) + sep) ||
        !/^sync-[a-f0-9-]+$/.test(temporary.split(sep).pop() || '')
      )
        throw new Error('同步临时目录无效。');
      await rm(temporary, { recursive: true, force: true });
    }
  }
}

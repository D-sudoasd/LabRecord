import { DatabaseSync, backup } from 'node:sqlite';
import JSZip from 'jszip';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, rename, stat, readdir, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import type { Attachment, Snapshot } from '../shared/model.js';
import { Store } from './store.js';
import { archiveSchema } from './archive-validation.js';
import { filenameFor } from '../shared/model.js';

const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex');
const attachmentPath = /^attachments\/[a-f0-9-]+\.(png|jpg|webp|gif)$/;
const MAX_PACKAGE_BYTES = 512 * 1024 * 1024;
interface Manifest {
  format: 'LabRecordBackup';
  version: 1;
  createdAt: string;
  files: { name: string; sha256: string; size: number }[];
}
export function inspectDatabase(path: string): Snapshot {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const version = db.prepare('PRAGMA user_version').get() as { user_version: number };
    if (version.user_version !== 1) throw new Error('备份的数据格式版本不兼容。');
    const check = db.prepare('PRAGMA quick_check').get() as { quick_check: string };
    if (check.quick_check !== 'ok' || db.prepare('PRAGMA foreign_key_check').all().length)
      throw new Error('备份数据库完整性检查失败。');
    const result: Snapshot = {
      schemaVersion: 1,
      experiments: [],
      groups: [],
      samples: [],
      items: [],
      runs: [],
      events: [],
      attachments: [],
    };
    const refs: Record<string, Record<string, string>> = {
      experiments: {},
      groups: { experiment_id: 'experimentId' },
      samples: { experiment_id: 'experimentId', group_id: 'groupId', code: 'code' },
      items: { experiment_id: 'experimentId', sample_id: 'sampleId', status: 'status' },
      runs: {
        experiment_id: 'experimentId',
        sample_id: 'sampleId',
        item_id: 'itemId',
        filename: 'filename',
      },
      events: { experiment_id: 'experimentId', item_id: 'itemId', run_id: 'runId' },
      attachments: { experiment_id: 'experimentId', run_id: 'runId' },
    };
    for (const table of Object.keys(refs)) {
      const rows = db.prepare(`SELECT * FROM ${table}`).all();
      if (rows.length > 100000) throw new Error('备份记录数量超过限制。');
      const objects = rows.map((row) => {
        const object = JSON.parse(String(row.json));
        if (!object || typeof object !== 'object' || object.id !== row.id)
          throw new Error('备份记录编号无效。');
        for (const [column, key] of Object.entries(refs[table]))
          if ((object[key] ?? null) !== row[column])
            throw new Error('备份的记录内容与数据库索引不一致。');
        return object;
      });
      (result as unknown as Record<string, unknown>)[table] = objects;
    }
    if (!archiveSchema.safeParse(result).success)
      throw new Error('备份中的字段类型、单位或记录格式无效。');
    for (const group of result.groups) if (group.protocol == null) group.protocol = '';
    const validTime = (value: unknown) =>
      value === null || (typeof value === 'string' && Number.isFinite(Date.parse(value)));
    for (const sample of result.samples) {
      const group = result.groups.find((g) => g.id === sample.groupId);
      if (!group || group.experimentId !== sample.experimentId)
        throw new Error('备份中的样品与样品组不匹配。');
    }
    for (const experiment of result.experiments)
      if (
        typeof experiment.code !== 'string' ||
        typeof experiment.name !== 'string' ||
        typeof experiment.namingPattern !== 'string' ||
        !Array.isArray(experiment.fields)
      )
        throw new Error('备份中的实验信息无效。');
    for (const group of result.groups)
      if (
        typeof group.state !== 'string' ||
        (group.preparedCount !== null &&
          (!Number.isInteger(group.preparedCount) || group.preparedCount < 0)) ||
        !group.values ||
        !['P0', 'P1', 'P2'].includes(group.priority)
      )
        throw new Error('备份中的样品组信息无效。');
    if (result.items.filter((i) => i.status === 'running').length > 1)
      throw new Error('备份存在多个同时进行的操作。');
    const names = new Set<string>(),
      nameNumbers = new Set<string>();
    for (const item of result.items) {
      const sample = result.samples.find((s) => s.id === item.sampleId);
      const run = result.runs.find((r) => r.itemId === item.id);
      if (item.plannedName !== undefined) {
        if (/[{}]/.test(item.plannedName)) throw new Error('备份中的计划名称无效。');
        filenameFor(item.plannedName, '', '', 1);
        const key = item.plannedName.toLowerCase();
        if (
          names.has(key) ||
          result.runs.some(
            (entry) =>
              entry.itemId !== item.id &&
              entry.filename.toLowerCase() === item.plannedName!.toLowerCase(),
          )
        )
          throw new Error('备份中的计划名称重复。');
        if (run && run.filename !== item.plannedName)
          throw new Error('备份中的计划名称与实际记录不一致。');
        names.add(key);
      }
      if (item.nameNumber !== undefined) {
        const key = `${item.experimentId}:${item.nameNumber}`;
        if (nameNumbers.has(key)) throw new Error('备份中的计划命名序号重复。');
        nameNumbers.add(key);
      }
      if (
        !sample ||
        sample.experimentId !== item.experimentId ||
        !['pending', 'running', 'completed', 'skipped', 'interrupted'].includes(item.status) ||
        typeof item.order !== 'number'
      )
        throw new Error('备份中的计划关联无效。');
      if (['running', 'completed', 'interrupted'].includes(item.status) && !run)
        throw new Error('备份中的操作缺少实际记录。');
      if (item.repeatOf) {
        const original = result.items.find((i) => i.id === item.repeatOf);
        if (
          !original ||
          original.id === item.id ||
          original.sampleId !== item.sampleId ||
          original.experimentId !== item.experimentId
        )
          throw new Error('备份中的重测关联无效。');
      }
      if (
        run &&
        ((item.status === 'running' && run.endedAt !== null) ||
          (['completed', 'interrupted'].includes(item.status) && run.endedAt === null) ||
          ['pending', 'skipped'].includes(item.status))
      )
        throw new Error('备份中的操作状态与结束时间不匹配。');
    }
    for (const event of result.events) {
      const item = event.itemId && result.items.find((i) => i.id === event.itemId);
      const run = event.runId && result.runs.find((r) => r.id === event.runId);
      if (
        (item && item.experimentId !== event.experimentId) ||
        (run && (run.experimentId !== event.experimentId || (item && run.itemId !== item.id)))
      )
        throw new Error('备份中的问题或备注关联无效。');
    }
    for (const attachment of result.attachments)
      if (
        result.runs.find((r) => r.id === attachment.runId)?.experimentId !== attachment.experimentId
      )
        throw new Error('备份中的附件关联无效。');
    for (const run of result.runs) {
      const item = result.items.find((i) => i.id === run.itemId);
      if (
        !item ||
        item.sampleId !== run.sampleId ||
        item.experimentId !== run.experimentId ||
        !validTime(run.startedAt) ||
        !validTime(run.endedAt) ||
        !validTime(run.originalStartedAt) ||
        !validTime(run.originalEndedAt) ||
        !run.snapshot?.group ||
        !run.snapshot.sample ||
        !Array.isArray(run.snapshot.fields) ||
        !run.actual
      )
        throw new Error('备份中的操作记录无效。');
      if (run.startedAt && run.endedAt && run.endedAt < run.startedAt)
        throw new Error('备份中的起止时间顺序无效。');
    }
    for (const attachment of result.attachments)
      if (
        !attachmentPath.test(attachment.relativePath) ||
        !/^[a-f0-9]{64}$/.test(attachment.sha256) ||
        !Number.isInteger(attachment.size) ||
        attachment.size > 10 * 1024 * 1024 ||
        attachment.size < 1
      )
        throw new Error('备份附件路径或大小无效。');
    return result;
  } finally {
    db.close();
  }
}
export async function addAttachment(
  store: Store,
  runId: string,
  file: string,
): Promise<Attachment> {
  const run = store.get('runs', runId);
  const meta = await stat(file);
  if (!meta.isFile() || meta.size > 10 * 1024 * 1024)
    throw new Error('请选择不超过 10 MB 的图片文件。');
  const buffer = await readFile(file);
  let mime = '',
    extension = '';
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    mime = 'image/png';
    extension = 'png';
  } else if (buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) {
    mime = 'image/jpeg';
    extension = 'jpg';
  } else if (
    buffer
      .subarray(0, 6)
      .toString()
      .match(/^GIF8[79]a$/)
  ) {
    mime = 'image/gif';
    extension = 'gif';
  } else if (
    buffer.subarray(0, 4).toString() === 'RIFF' &&
    buffer.subarray(8, 12).toString() === 'WEBP'
  ) {
    mime = 'image/webp';
    extension = 'webp';
  } else throw new Error('支持 PNG、JPEG、GIF 或 WebP 图片。');
  const id = randomUUID();
  const attachment: Attachment = {
    id,
    runId,
    experimentId: run.experimentId,
    name: file.split(/[\\/]/).pop()!,
    mime,
    relativePath: `attachments/${id}.${extension}`,
    sha256: hash(buffer),
    size: buffer.length,
  };
  const target = join(store.root, attachment.relativePath);
  await writeFile(target, buffer, { flag: 'wx' });
  try {
    store.transaction(() => {
      store.put('attachments', attachment);
      store.event(
        run.experimentId,
        'attachment',
        `添加图片：${attachment.name}`,
        run.itemId,
        runId,
      );
    });
  } catch (error) {
    await unlink(target);
    throw error;
  }
  return attachment;
}
export async function createBackup(store: Store, path: string) {
  await mkdir(dirname(path), { recursive: true });
  const temporaryDatabase = join(dirname(path), `.backup-${randomUUID()}.sqlite`);
  const temporaryPackage = path + `.${randomUUID()}.tmp`;
  try {
    await backup(store.db, temporaryDatabase);
    const snapshot = inspectDatabase(temporaryDatabase);
    const zip = new JSZip();
    const files: Manifest['files'] = [];
    const add = (name: string, buffer: Buffer) => {
      files.push({ name, size: buffer.length, sha256: hash(buffer) });
      zip.file(name, buffer);
    };
    add('records.sqlite', await readFile(temporaryDatabase));
    let size = files[0].size;
    for (const attachment of snapshot.attachments) {
      const buffer = await readFile(join(store.root, attachment.relativePath));
      if (buffer.length !== attachment.size || hash(buffer) !== attachment.sha256)
        throw new Error(`附件完整性检查失败：${attachment.name}`);
      size += buffer.length;
      if (size > MAX_PACKAGE_BYTES) throw new Error('完整备份超过 512 MB。');
      add(attachment.relativePath, buffer);
    }
    const manifest: Manifest = {
      format: 'LabRecordBackup',
      version: 1,
      createdAt: new Date().toISOString(),
      files,
    };
    zip.file('manifest.json', JSON.stringify(manifest, null, 2));
    await writeFile(
      temporaryPackage,
      await zip.generateAsync({
        type: 'nodebuffer',
        compression: 'DEFLATE',
        compressionOptions: { level: 3 },
      }),
      { flag: 'wx' },
    );
    await rename(temporaryPackage, path);
  } finally {
    await unlink(temporaryDatabase).catch(() => {});
    await unlink(temporaryPackage).catch(() => {});
  }
}
export async function unpackBackup(path: string, target: string): Promise<Snapshot> {
  const meta = await stat(path);
  if (meta.size > MAX_PACKAGE_BYTES) throw new Error('备份包超过 512 MB。');
  const zip = await JSZip.loadAsync(await readFile(path), { checkCRC32: true });
  const manifestFile = zip.file('manifest.json');
  if (!manifestFile) throw new Error('文件不是 LabRecord 备份包。');
  const manifest = JSON.parse(await manifestFile.async('string')) as Manifest;
  if (
    manifest.format !== 'LabRecordBackup' ||
    manifest.version !== 1 ||
    !Array.isArray(manifest.files) ||
    manifest.files.length > 10000
  )
    throw new Error('备份包版本或文件清单无效。');
  const names = new Set<string>();
  let size = 0;
  for (const file of manifest.files) {
    if (
      typeof file.name !== 'string' ||
      !(file.name === 'records.sqlite' || attachmentPath.test(file.name)) ||
      names.has(file.name) ||
      !Number.isInteger(file.size) ||
      file.size < 1 ||
      !/^[a-f0-9]{64}$/.test(file.sha256)
    )
      throw new Error('备份清单包含无效文件或重复路径。');
    names.add(file.name);
    size += file.size;
  }
  if (!names.has('records.sqlite') || size > MAX_PACKAGE_BYTES)
    throw new Error('备份缺少数据库或展开大小超过限制。');
  for (const [name, entry] of Object.entries(zip.files))
    if (!entry.dir && name !== 'manifest.json' && !names.has(name))
      throw new Error('备份包含清单之外的文件。');
  await mkdir(join(target, 'attachments'), { recursive: true });
  for (const file of manifest.files) {
    const entry = zip.file(file.name);
    if (!entry) throw new Error(`备份缺少文件：${file.name}`);
    const buffer = await entry.async('nodebuffer');
    if (buffer.length !== file.size || hash(buffer) !== file.sha256)
      throw new Error(`备份文件校验失败：${file.name}`);
    await writeFile(join(target, file.name), buffer, { flag: 'wx' });
  }
  const snapshot = inspectDatabase(join(target, 'records.sqlite'));
  for (const attachment of snapshot.attachments) {
    const entry = manifest.files.find((f) => f.name === attachment.relativePath);
    if (!entry || entry.sha256 !== attachment.sha256 || entry.size !== attachment.size)
      throw new Error('数据库中的附件与备份清单不匹配。');
  }
  return snapshot;
}
export async function dailyBackup(store: Store, directory: string) {
  if (!store.list('experiments').length) return;
  await mkdir(directory, { recursive: true });
  const today = new Date().toLocaleDateString('sv-SE');
  const name = `auto-${today}.labrecord`;
  const names = await readdir(directory);
  if (!names.includes(name)) await createBackup(store, join(directory, name));
  const automatic = (await readdir(directory))
    .filter((n) => /^auto-\d{4}-\d{2}-\d{2}\.labrecord$/.test(n))
    .sort();
  for (const old of automatic.slice(0, Math.max(0, automatic.length - 10)))
    await unlink(join(directory, old));
}

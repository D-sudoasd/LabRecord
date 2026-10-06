import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_PATTERN, filenameFor } from '../shared/model.js';
import type {
  Snapshot,
  Experiment,
  Group,
  Sample,
  PlanItem,
  Run,
  RecordEvent,
  Attachment,
  CommandResult,
  Values,
  Field,
} from '../shared/model.js';
import { validateCommand } from './validation.js';

type Entities = {
  experiments: Experiment;
  groups: Group;
  samples: Sample;
  items: PlanItem;
  runs: Run;
  events: RecordEvent;
  attachments: Attachment;
};
type Table = keyof Entities;
type Selection = { experimentId?: string; itemId?: string };
const columns: Record<Table, Record<string, string>> = {
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
export class Store {
  db: DatabaseSync;
  constructor(
    readonly root: string,
    readonly clock: () => Date = () => new Date(),
  ) {
    mkdirSync(root, { recursive: true });
    mkdirSync(join(root, 'attachments'), { recursive: true });
    this.db = new DatabaseSync(join(root, 'records.sqlite'), { timeout: 5000 });
    const version = (this.db.prepare('PRAGMA user_version').get() as { user_version: number })
      .user_version;
    if (version > 1) {
      this.db.close();
      throw new Error('此数据由更新版本创建，请使用更新的 LabRecord。');
    }
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS experiments(id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS groups(id TEXT PRIMARY KEY, experiment_id TEXT NOT NULL REFERENCES experiments(id), json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS samples(id TEXT PRIMARY KEY, experiment_id TEXT NOT NULL REFERENCES experiments(id), group_id TEXT NOT NULL REFERENCES groups(id), code TEXT NOT NULL COLLATE NOCASE, json TEXT NOT NULL, UNIQUE(experiment_id, code));
      CREATE TABLE IF NOT EXISTS items(id TEXT PRIMARY KEY, experiment_id TEXT NOT NULL REFERENCES experiments(id), sample_id TEXT NOT NULL REFERENCES samples(id), status TEXT NOT NULL CHECK(status IN ('pending','running','completed','interrupted','skipped')), json TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS one_running ON items(status) WHERE status='running';
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, experiment_id TEXT NOT NULL REFERENCES experiments(id), sample_id TEXT NOT NULL REFERENCES samples(id), item_id TEXT UNIQUE NOT NULL REFERENCES items(id), filename TEXT NOT NULL COLLATE NOCASE, json TEXT NOT NULL, UNIQUE(experiment_id, filename));
      CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY, experiment_id TEXT NOT NULL REFERENCES experiments(id), item_id TEXT REFERENCES items(id), run_id TEXT REFERENCES runs(id), json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS attachments(id TEXT PRIMARY KEY, experiment_id TEXT NOT NULL REFERENCES experiments(id), run_id TEXT NOT NULL REFERENCES runs(id), json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result TEXT NOT NULL);
      PRAGMA user_version=1;`);
  }
  close() {
    this.db.close();
  }
  now() {
    return this.clock().toISOString();
  }
  list<T extends Table>(table: T): Entities[T][] {
    return this.db
      .prepare(`SELECT json FROM ${table} ORDER BY rowid`)
      .all()
      .map((row) => JSON.parse(row.json as string));
  }
  get<T extends Table>(table: T, id: string): Entities[T] {
    const row = this.db.prepare(`SELECT json FROM ${table} WHERE id=?`).get(id);
    if (!row) throw new Error('记录不存在，请刷新后重试。');
    return JSON.parse(row.json as string);
  }
  put<T extends Table>(table: T, value: Entities[T]) {
    const names = Object.keys(columns[table]);
    const data = value as unknown as Record<string, string | null>;
    this.db
      .prepare(
        `INSERT INTO ${table}(id,json${names.map((n) => ',' + n).join('')}) VALUES(?,?${names.map(() => ',?').join('')}) ON CONFLICT(id) DO UPDATE SET json=excluded.json${names.map((n) => `,${n}=excluded.${n}`).join('')}`,
      )
      .run(value.id, JSON.stringify(value), ...names.map((n) => data[columns[table][n]] ?? null));
  }
  snapshot(): Snapshot {
    return {
      schemaVersion: 1,
      experiments: this.list('experiments'),
      groups: this.list('groups'),
      samples: this.list('samples'),
      items: this.list('items'),
      runs: this.list('runs'),
      events: this.list('events'),
      attachments: this.list('attachments'),
    };
  }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  event(
    experimentId: string,
    type: string,
    text: string,
    itemId: string | null = null,
    runId: string | null = null,
    data: Record<string, unknown> = {},
  ) {
    const event: RecordEvent = {
      id: randomUUID(),
      experimentId,
      type,
      text,
      itemId,
      runId,
      data,
      createdAt: this.now(),
    };
    this.put('events', event);
    return event;
  }
  checkValues(fields: Field[], values: Values) {
    for (const field of fields) {
      const value = values[field.id];
      if (value === null || value === undefined || value === '') continue;
      if (field.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value)))
        throw new Error(`${field.label} 应填写数值，单位为 ${field.unit || '未指定'}。`);
      if (field.type === 'select' && !field.options.includes(String(value)))
        throw new Error(`${field.label} 不在预设选项中。`);
    }
  }
  createGroup(experimentId: string, patch: Partial<Group>) {
    const experiment = this.get('experiments', experimentId);
    const group: Group = {
      id: randomUUID(),
      experimentId,
      state: '新样品组',
      name: '',
      width: '',
      height: '',
      dimensionUnit: '',
      preparedCount: null,
      mode: '未定',
      priority: 'P0',
      thickness: '',
      thicknessUnit: '',
      preparation: '',
      notes: '',
      values: {},
      order: this.list('groups').filter((g) => g.experimentId === experimentId).length,
      legacyCompleted: null,
      legacyTime: '',
      ...patch,
    };
    this.checkValues(experiment.fields, group.values);
    this.put('groups', group);
    return group;
  }
  arrange(groupId: string, count: number, prefix?: string): Selection {
    const group = this.get('groups', groupId);
    const samples = this.list('samples');
    const planned = samples.filter((s) => s.groupId === group.id).length;
    if (group.preparedCount !== null && planned + count > group.preparedCount)
      throw new Error(`准备 ${group.preparedCount} 个，已安排 ${planned} 个；请先核对准备数量。`);
    const codes = new Set(
      samples.filter((s) => s.experimentId === group.experimentId).map((s) => s.code.toLowerCase()),
    );
    let ordinal = 1;
    let order =
      Math.max(
        -1,
        ...this.list('items')
          .filter((i) => i.experimentId === group.experimentId)
          .map((i) => i.order),
      ) + 1;
    let firstId: string | undefined;
    for (let index = 0; index < count; index++) {
      let code: string;
      do {
        code = (prefix?.trim() || `${group.state}-`) + String(ordinal++).padStart(2, '0');
      } while (codes.has(code.toLowerCase()));
      codes.add(code.toLowerCase());
      const sample: Sample = {
        id: randomUUID(),
        experimentId: group.experimentId,
        groupId,
        code,
        values: {},
        parameters: {},
      };
      this.put('samples', sample);
      const item: PlanItem = {
        id: randomUUID(),
        experimentId: group.experimentId,
        sampleId: sample.id,
        operation: '测量',
        order: order++,
        status: 'pending',
      };
      this.put('items', item);
      firstId ??= item.id;
    }
    this.event(group.experimentId, 'plan', `安排 ${count} 个样品进行测试`);
    return { experimentId: group.experimentId, itemId: firstId };
  }
  private makeRun(
    item: PlanItem,
    startedAt: string | null,
    endedAt: string | null,
    automatic: boolean,
  ) {
    const experiment = this.get('experiments', item.experimentId);
    const sample = this.get('samples', item.sampleId);
    const group = { ...this.get('groups', sample.groupId), ...sample.parameters } as Group;
    const number =
      Math.max(
        0,
        ...this.list('runs')
          .filter((r) => r.experimentId === item.experimentId)
          .map((r) => r.number),
      ) + 1;
    const filename = filenameFor(experiment.namingPattern, experiment.code, sample.code, number);
    if (
      this.list('runs').some(
        (r) =>
          r.experimentId === item.experimentId &&
          r.filename.toLowerCase() === filename.toLowerCase(),
      )
    )
      throw new Error('预期文件名与已有操作重复，请在实验设置中调整命名规则。');
    const run: Run = {
      id: randomUUID(),
      experimentId: item.experimentId,
      itemId: item.id,
      sampleId: sample.id,
      number,
      filename,
      startedAt,
      endedAt,
      originalStartedAt: automatic ? startedAt : null,
      originalEndedAt: null,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      offsetMinutes: -this.clock().getTimezoneOffset(),
      snapshot: {
        group: structuredClone(group),
        sample: structuredClone(sample),
        operation: item.operation,
        fields: structuredClone(experiment.fields),
      },
      actual: {
        mode: group.mode,
        thickness: group.thickness,
        thicknessUnit: group.thicknessUnit,
        preparation: group.preparation,
        filename: '',
        scanId: '',
        files: '',
        ...group.values,
        ...sample.values,
      },
      actualSample: {
        name: group.name || '',
        width: group.width || '',
        height: group.height || '',
        dimensionUnit: group.dimensionUnit || '',
      },
      notes: '',
    };
    this.put('runs', run);
    return run;
  }
  command(input: unknown, requestId = randomUUID()): CommandResult {
    const command = validateCommand(input);
    if (typeof requestId !== 'string' || requestId.length > 200 || !requestId)
      throw new Error('请求编号无效。');
    const fingerprint = createHash('sha256').update(JSON.stringify(command)).digest('hex');
    const previous = this.db
      .prepare('SELECT fingerprint,result FROM requests WHERE id=?')
      .get(requestId);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new Error('请求编号已经用于另一项操作。');
      return { snapshot: this.snapshot(), ...JSON.parse(previous.result as string) };
    }
    const selection = this.transaction(() => {
      const result = this.execute(command);
      this.db
        .prepare('INSERT INTO requests(id,fingerprint,result) VALUES(?,?,?)')
        .run(requestId, fingerprint, JSON.stringify(result));
      return result;
    });
    return { snapshot: this.snapshot(), ...selection };
  }
  private execute(command: ReturnType<typeof validateCommand>): Selection {
    switch (command.type) {
      case 'createExperiment': {
        if (
          this.list('experiments').some((e) => e.code.toLowerCase() === command.code.toLowerCase())
        )
          throw new Error('实验编号已经存在。');
        const experiment: Experiment = {
          id: randomUUID(),
          code: command.code,
          name: command.name,
          description: command.description || '',
          fields: [],
          namingPattern: DEFAULT_PATTERN,
          createdAt: this.now(),
        };
        this.put('experiments', experiment);
        this.event(experiment.id, 'plan', '建立实验规划');
        return { experimentId: experiment.id };
      }
      case 'updateExperiment': {
        const experiment = this.get('experiments', command.id);
        if (command.namingPattern !== undefined)
          filenameFor(command.namingPattern, experiment.code, 'SAMPLE', 1);
        if (command.fields) {
          if (new Set(command.fields.map((f) => f.id)).size !== command.fields.length)
            throw new Error('自定义字段编号重复。');
          if (
            new Set(command.fields.map((f) => f.label.toLowerCase())).size !== command.fields.length
          )
            throw new Error('自定义字段名称重复，请使用不同名称。');
          if (command.fields.some((f) => f.type === 'select' && f.options.length === 0))
            throw new Error('选项字段至少需要一个选项。');
        }
        const { type: _type, id: _id, ...patch } = command;
        this.put('experiments', { ...experiment, ...patch });
        return { experimentId: experiment.id };
      }
      case 'createGroup': {
        this.createGroup(command.experimentId, command.patch);
        return { experimentId: command.experimentId };
      }
      case 'addSamples': {
        const group = this.createGroup(command.experimentId, command.patch);
        return command.count
          ? this.arrange(group.id, command.count, command.prefix || 'S')
          : { experimentId: command.experimentId };
      }
      case 'temporary': {
        if (command.patch.preparedCount === 0)
          throw new Error('临时样品的准备数量至少为 1；未知时可以留空。');
        const group = this.createGroup(command.experimentId, command.patch);
        return this.arrange(group.id, 1);
      }
      case 'updateGroups': {
        for (const id of command.ids) {
          const group = this.get('groups', id);
          const next = {
            ...group,
            ...command.patch,
            values: { ...group.values, ...command.patch.values },
          };
          this.checkValues(this.get('experiments', group.experimentId).fields, next.values);
          this.put('groups', next);
        }
        return {};
      }
      case 'copyGroup': {
        const original = this.get('groups', command.id);
        const {
          id: _id,
          order: _order,
          legacyCompleted: _complete,
          legacyTime: _time,
          ...patch
        } = original;
        this.createGroup(original.experimentId, patch);
        return { experimentId: original.experimentId };
      }
      case 'arrange':
        return this.arrange(command.groupId, command.count, command.prefix);
      case 'updateSamples': {
        if (command.code && command.ids.length !== 1)
          throw new Error('样品编号只能逐个修改，批量编号请在安排测试时设置前缀。');
        for (const id of command.ids) {
          const sample = this.get('samples', id);
          const next = {
            ...sample,
            code: command.code || sample.code,
            values: { ...sample.values, ...command.values },
            parameters: { ...sample.parameters, ...command.parameters },
          };
          this.checkValues(this.get('experiments', sample.experimentId).fields, next.values);
          this.put('samples', next);
        }
        return {};
      }
      case 'reorder': {
        const existing = this.list('items').filter((i) => i.experimentId === command.experimentId);
        if (
          command.ids.length !== existing.length ||
          new Set(command.ids).size !== existing.length ||
          existing.some((i) => !command.ids.includes(i.id))
        )
          throw new Error('队列已变化，请重新排序。');
        command.ids.forEach((id, order) => this.put('items', { ...this.get('items', id), order }));
        return {};
      }
      case 'start': {
        const item = this.get('items', command.itemId);
        if (item.status === 'running') return { itemId: item.id, experimentId: item.experimentId };
        if (item.status !== 'pending')
          throw new Error('该操作已经结束；需要再次测量时请选择重测。');
        if (this.list('items').some((i) => i.status === 'running'))
          throw new Error('还有进行中的操作，请先完成或中断当前操作。');
        const run = this.makeRun(item, this.now(), null, true);
        this.put('items', { ...item, status: 'running' });
        this.event(item.experimentId, 'start', '开始操作', item.id, run.id);
        return { itemId: item.id, experimentId: item.experimentId };
      }
      case 'finish':
      case 'interrupt': {
        const item = this.get('items', command.itemId);
        const target = command.type === 'finish' ? 'completed' : 'interrupted';
        if (item.status === target) return { itemId: item.id, experimentId: item.experimentId };
        if (item.status !== 'running') throw new Error('只有进行中的操作可以完成或中断。');
        const run = this.list('runs').find((r) => r.itemId === item.id)!;
        const endedAt = this.now();
        if (run.startedAt && endedAt < run.startedAt)
          throw new Error('系统时间早于开始时间，请先修正时间。');
        this.put('runs', { ...run, endedAt, originalEndedAt: run.originalEndedAt ?? endedAt });
        this.put('items', { ...item, status: target });
        this.event(
          item.experimentId,
          command.type,
          target === 'completed' ? '完成操作' : '中断操作',
          item.id,
          run.id,
        );
        const next = this.list('items')
          .filter((i) => i.experimentId === item.experimentId && i.status === 'pending')
          .sort((a, b) => a.order - b.order)[0];
        return { experimentId: item.experimentId, itemId: next?.id || item.id };
      }
      case 'skip':
      case 'unskip': {
        const item = this.get('items', command.itemId);
        if (item.status !== (command.type === 'skip' ? 'pending' : 'skipped'))
          throw new Error('该操作状态不允许此操作。');
        this.put('items', { ...item, status: command.type === 'skip' ? 'skipped' : 'pending' });
        this.event(
          item.experimentId,
          'plan',
          command.type === 'skip' ? '跳过操作' : '恢复到待测队列',
          item.id,
        );
        return {};
      }
      case 'repeat': {
        const original = this.get('items', command.itemId);
        if (!['completed', 'interrupted'].includes(original.status))
          throw new Error('完成或中断的操作才能安排重测。');
        const pending = this.list('items').find(
          (i) => i.repeatOf === original.id && ['pending', 'running'].includes(i.status),
        );
        if (pending) return { experimentId: pending.experimentId, itemId: pending.id };
        const item = {
          ...original,
          id: randomUUID(),
          repeatOf: original.id,
          operation: '重测',
          order:
            Math.max(
              ...this.list('items')
                .filter((i) => i.experimentId === original.experimentId)
                .map((i) => i.order),
            ) + 1,
          status: 'pending' as const,
        };
        this.put('items', item);
        this.event(item.experimentId, 'plan', '新增一次重测操作', item.id, null, {
          originalItemId: original.id,
          sampleId: original.sampleId,
        });
        return { experimentId: item.experimentId, itemId: item.id };
      }
      case 'saveRun': {
        const run = this.get('runs', command.runId);
        const actual = { ...run.actual, ...command.actual };
        this.checkValues(run.snapshot.fields, actual);
        const actualSample = command.actualSample
          ? {
              name: '',
              width: '',
              height: '',
              dimensionUnit: '',
              ...run.actualSample,
              ...command.actualSample,
            }
          : run.actualSample;
        this.put('runs', { ...run, actual, actualSample, notes: command.notes ?? run.notes });
        if (command.notes !== undefined && command.notes !== run.notes)
          this.event(
            run.experimentId,
            'edit',
            command.notes || '清空现场备注',
            run.itemId,
            run.id,
            { previous: run.notes },
          );
        if (command.actual)
          this.event(run.experimentId, 'actual', '更新实际操作参数', run.itemId, run.id, {
            previous: run.actual,
            changes: command.actual,
          });
        if (command.actualSample)
          this.event(run.experimentId, 'actual', '更新实际样品名称与尺寸', run.itemId, run.id, {
            previous: run.actualSample || null,
            changes: command.actualSample,
          });
        return {};
      }
      case 'addEvent': {
        this.get('experiments', command.experimentId);
        if (
          command.itemId &&
          this.get('items', command.itemId).experimentId !== command.experimentId
        )
          throw new Error('操作不属于当前实验。');
        if (command.runId && this.get('runs', command.runId).experimentId !== command.experimentId)
          throw new Error('记录不属于当前实验。');
        if (
          command.runId &&
          command.itemId &&
          this.get('runs', command.runId).itemId !== command.itemId
        )
          throw new Error('操作与记录不匹配。');
        this.event(
          command.experimentId,
          command.eventType,
          command.text,
          command.itemId || null,
          command.runId || null,
          { category: command.category || '其他', resolvedAt: null },
        );
        return {};
      }
      case 'resolveIssue': {
        const event = this.get('events', command.eventId);
        if (event.type !== 'issue') throw new Error('该记录不是问题记录。');
        this.put('events', { ...event, data: { ...event.data, resolvedAt: this.now() } });
        return {};
      }
      case 'times': {
        const item = this.get('items', command.itemId);
        const normalize = (time: string | null) => {
          if (!time) return null;
          if (!/(Z|[+-]\d\d:\d\d)$/.test(time) || !Number.isFinite(Date.parse(time)))
            throw new Error('时间需要包含日期及有效时区。');
          return new Date(time).toISOString();
        };
        const startedAt = normalize(command.startedAt),
          endedAt = normalize(command.endedAt);
        if (!startedAt && !endedAt) throw new Error('至少填写一个时间；未知时间可以留空。');
        if (startedAt && endedAt && endedAt < startedAt)
          throw new Error('结束时间不能早于开始时间。');
        if (item.status === 'skipped') throw new Error('请先恢复到待测队列，再补录时间。');
        let run = this.list('runs').find((r) => r.itemId === item.id);
        if (!endedAt && this.list('items').some((i) => i.status === 'running' && i.id !== item.id))
          throw new Error('已有另一项操作进行中。');
        const previous = run ? { startedAt: run.startedAt, endedAt: run.endedAt } : null;
        run = run ? { ...run, startedAt, endedAt } : this.makeRun(item, startedAt, endedAt, false);
        this.put('runs', run);
        this.put('items', {
          ...item,
          status: endedAt
            ? item.status === 'interrupted'
              ? 'interrupted'
              : 'completed'
            : 'running',
        });
        this.event(
          item.experimentId,
          'correction',
          command.reason || '补录或修正起止时间',
          item.id,
          run.id,
          { previous, startedAt, endedAt },
        );
        return { experimentId: item.experimentId, itemId: item.id };
      }
      case 'demo': {
        const code =
          'DEMO-' + (this.list('experiments').filter((e) => e.code.startsWith('DEMO-')).length + 1);
        const result = this.execute({
          type: 'createExperiment',
          name: '同步辐射实验 · 演示',
          code,
          description:
            '这是演示数据，可用于练习规划、现场记录与导出。示例状态和数值不代表真实实验。',
        });
        const id = result.experimentId!;
        this.execute({
          type: 'updateExperiment',
          id,
          fields: [
            { id: 'temperature', label: '温度', type: 'number', unit: '°C', options: [] },
            { id: 'composition', label: '成分', type: 'text', unit: '', options: [] },
          ],
        });
        const group = this.createGroup(id, {
          name: 'Ti-A 拉伸试样',
          state: 'Ti-A-热处理',
          preparedCount: 6,
          mode: 'In situ',
          thickness: '0.8',
          thicknessUnit: 'mm',
          width: '3',
          dimensionUnit: 'mm',
          notes: '四个待测样品，两个备样。核对装样方向。',
          preparation: 'Ti-A / 制备批次 A',
          values: { temperature: 25, composition: '演示材料' },
        });
        const first = this.arrange(group.id, 4, 'TA-');
        this.createGroup(id, {
          name: 'Ti-B 对照试样',
          state: 'Ti-B-对照',
          preparedCount: 3,
          mode: 'Ex situ',
          priority: 'P1',
          notes: '计划尚未安排；可在规划页选择测试数量。',
        });
        return first;
      }
    }
  }
}

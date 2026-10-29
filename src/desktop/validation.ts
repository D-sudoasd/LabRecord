import { z } from 'zod';
import { codePatternError, type Command, type GroupPatch } from '../shared/model.js';
const text = z.string().max(50000);
const id = z.string().min(1).max(200);
const values = z.record(z.string().max(200), z.union([text, z.number().finite(), z.null()]));
export const measurementSchema = z
  .object({
    mode: z.enum(['未定', 'In situ', 'Ex situ']).optional(),
    technique: z.string().max(80).optional(),
    regime: z.string().max(80).optional(),
    batch: z.string().max(80).optional(),
    protocol: text.optional(),
    customName: z.string().max(200).optional(),
  })
  .strict();
const specimenCode = z
  .string()
  .trim()
  .min(1)
  .max(300)
  .refine((value) => !/[\u0000-\u001f]/.test(value), '样品编号不能包含控制字符。');
const sampleCodePattern = z
  .string()
  .max(80)
  .refine(
    (value) => value.trim() === '' || codePatternError(value.trim()) === '',
    '编号样式需要恰好一个 {prefix}，以及一个 {n} 或 {n:02} 到 {n:09}。',
  );
const specimenInput = z
  .object({
    code: specimenCode.optional(),
    name: z.string().max(300).optional(),
    protocol: text.optional(),
    state: z.string().max(300).optional(),
    notes: text.optional(),
    fieldNote: text.optional(),
    thickness: text.optional(),
    thicknessUnit: z.string().max(40).optional(),
    width: text.optional(),
    height: text.optional(),
    dimensionUnit: z.string().max(40).optional(),
  })
  .strict();
const patch = z
  .object({
    state: z.string().trim().min(1).max(300).optional(),
    name: z.string().max(300).optional(),
    material: z.string().max(300).optional(),
    composition: z.string().max(3000).optional(),
    processing: z.string().max(3000).optional(),
    heatTreatment: z.string().max(3000).optional(),
    otherTreatment: z.string().max(3000).optional(),
    width: text.optional(),
    height: text.optional(),
    dimensionUnit: z.string().max(40).optional(),
    preparedCount: z.number().int().min(0).max(10000).nullable().optional(),
    mode: z.enum(['未定', 'In situ', 'Ex situ']).optional(),
    priority: z.enum(['P0', 'P1', 'P2']).optional(),
    thickness: text.optional(),
    thicknessUnit: z.string().max(40).optional(),
    preparation: text.optional(),
    notes: text.optional(),
    protocol: text.optional(),
    values: values.optional(),
  })
  .strict();
export const fieldSchema = z
  .object({
    id: id.refine(
      (value) =>
        ![
          'mode',
          'thickness',
          'thicknessUnit',
          'preparation',
          'protocol',
          'filename',
          'scanId',
          'files',
        ].includes(value),
      '字段编号不能与内置字段相同。',
    ),
    label: z.string().trim().min(1).max(100),
    type: z.enum(['text', 'number', 'select']),
    unit: z.string().max(40),
    options: z.array(z.string().min(1).max(300)).max(100),
  })
  .strict();
const itemCommand = (type: string) => z.object({ type: z.literal(type), itemId: id }).strict();
const statusReason = z
  .string()
  .trim()
  .min(1, '原因请写成一行，不超过 80 个字。')
  .max(80, '原因请写成一行，不超过 80 个字。')
  .refine((value) => !/[\r\n\u0000]/.test(value), '原因请写成一行，不超过 80 个字。')
  .optional();
const schemas: Record<string, z.ZodType> = {
  createExperiment: z
    .object({
      type: z.literal('createExperiment'),
      name: z.string().trim().min(1).max(300),
      code: z.string().trim().min(1).max(80),
      description: text.optional(),
      namingPattern: z.string().max(240).optional(),
      sampleCodePattern: sampleCodePattern.optional(),
      fields: z.array(fieldSchema).max(50).optional(),
    })
    .strict(),
  updateExperiment: z
    .object({
      type: z.literal('updateExperiment'),
      id,
      name: z.string().trim().min(1).max(300).optional(),
      description: text.optional(),
      fields: z.array(fieldSchema).max(50).optional(),
      namingPattern: z.string().max(240).optional(),
      sampleCodePattern: sampleCodePattern.optional(),
    })
    .strict(),
  createGroup: z.object({ type: z.literal('createGroup'), experimentId: id, patch }).strict(),
  addSamples: z
    .object({
      type: z.literal('addSamples'),
      experimentId: id,
      patch,
      count: z.number().int().min(0).max(1000),
      prefix: z.string().max(250).optional(),
      specimens: z.array(specimenInput).max(1000).optional(),
      measurement: measurementSchema.optional(),
    })
    .strict(),
  temporary: z.object({ type: z.literal('temporary'), experimentId: id, patch }).strict(),
  updateGroups: z
    .object({ type: z.literal('updateGroups'), ids: z.array(id).min(1).max(1000), patch })
    .strict(),
  copyGroup: z.object({ type: z.literal('copyGroup'), id }).strict(),
  deleteGroups: z
    .object({ type: z.literal('deleteGroups'), ids: z.array(id).min(1).max(1000) })
    .strict(),
  deleteSamples: z
    .object({ type: z.literal('deleteSamples'), ids: z.array(id).min(1).max(1000) })
    .strict(),
  deleteItems: z
    .object({ type: z.literal('deleteItems'), ids: z.array(id).min(1).max(1000) })
    .strict(),
  deleteExperiment: z.object({ type: z.literal('deleteExperiment'), id }).strict(),
  arrange: z
    .object({
      type: z.literal('arrange'),
      groupId: id,
      count: z.number().int().min(1).max(1000),
      prefix: z.string().max(250).optional(),
      measurement: measurementSchema.optional(),
      specimens: z.array(specimenInput).max(1000).optional(),
    })
    .strict(),
  updateSamples: z
    .object({
      type: z.literal('updateSamples'),
      ids: z.array(id).min(1).max(1000),
      parameters: patch.optional(),
      values: values.optional(),
      code: z.string().trim().min(1).max(300).optional(),
    })
    .strict(),
  reorder: z
    .object({ type: z.literal('reorder'), experimentId: id, ids: z.array(id).max(10000) })
    .strict(),
  configureMeasurements: z
    .object({
      type: z.literal('configureMeasurements'),
      ids: z.array(id).min(1).max(1000),
      measurement: measurementSchema,
    })
    .strict(),
  updateFieldRow: z
    .object({
      type: z.literal('updateFieldRow'),
      itemId: id,
      sample: z
        .object({
          name: z.string().max(300).optional(),
          state: z.string().max(300).optional(),
          thickness: text.optional(),
          thicknessUnit: z.string().max(40).optional(),
          width: text.optional(),
          height: text.optional(),
          dimensionUnit: z.string().max(40).optional(),
        })
        .strict()
        .optional(),
      protocol: text.optional(),
      fieldNote: text.optional(),
    })
    .strict()
    .refine(
      (value) =>
        value.sample !== undefined || value.protocol !== undefined || value.fieldNote !== undefined,
      '没有可保存的内容。',
    ),
  scheduleMeasurements: z
    .object({
      type: z.literal('scheduleMeasurements'),
      itemIds: z.array(id).min(1).max(1000),
      measurement: measurementSchema.optional(),
      repetitions: z.number().int().min(1).max(100).optional(),
    })
    .strict(),
  start: itemCommand('start'),
  finish: itemCommand('finish'),
  interrupt: z.object({ type: z.literal('interrupt'), itemId: id, reason: statusReason }).strict(),
  skip: z.object({ type: z.literal('skip'), itemId: id, reason: statusReason }).strict(),
  unskip: itemCommand('unskip'),
  repeat: itemCommand('repeat'),
  saveRun: z
    .object({
      type: z.literal('saveRun'),
      runId: id,
      notes: text.optional(),
      actual: values.optional(),
      actualSample: z
        .object({
          name: z.string().max(300).optional(),
          state: z.string().max(300).optional(),
          specimenName: z.string().max(300).optional(),
          width: text.optional(),
          height: text.optional(),
          dimensionUnit: z.string().max(40).optional(),
        })
        .strict()
        .optional(),
    })
    .strict(),
  addEvent: z
    .object({
      type: z.literal('addEvent'),
      experimentId: id,
      itemId: id.optional(),
      runId: id.optional(),
      eventType: z.enum(['note', 'issue']),
      text: z.string().trim().min(1).max(50000),
      category: z.string().max(100).optional(),
    })
    .strict(),
  resolveIssue: z.object({ type: z.literal('resolveIssue'), eventId: id }).strict(),
  editIssue: z
    .object({
      type: z.literal('editIssue'),
      eventId: id,
      text: z.string().trim().min(1).max(50000),
    })
    .strict(),
  editNote: z
    .object({
      type: z.literal('editNote'),
      eventId: id,
      text: z.string().trim().min(1).max(50000),
    })
    .strict(),
  times: z
    .object({
      type: z.literal('times'),
      itemId: id,
      startedAt: text.nullable(),
      endedAt: text.nullable(),
      reason: text.optional(),
    })
    .strict(),
  demo: z.object({ type: z.literal('demo') }).strict(),
};
/** Optional fields sent over IPC can explicitly contain undefined. Treat these
 * as absent, so spreading a patch cannot erase an existing saved value. */
function withoutUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutUndefined);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .map(([key, entry]) => [key, withoutUndefined(entry)]),
    );
  return value;
}

export function validateCommand(input: unknown): Command {
  if (
    !input ||
    typeof input !== 'object' ||
    !('type' in input) ||
    typeof input.type !== 'string' ||
    !Object.hasOwn(schemas, input.type)
  )
    throw new Error('不支持的操作。');
  const result = schemas[input.type].safeParse(input);
  if (!result.success)
    throw new Error(
      '输入格式不正确：' +
        result.error.issues
          .map((i) => `${i.path.join('.')} ${i.message}`)
          .slice(0, 3)
          .join('；'),
    );
  return withoutUndefined(result.data) as Command;
}
export function validatePatch(input: unknown): GroupPatch {
  return withoutUndefined(patch.parse(input)) as GroupPatch;
}

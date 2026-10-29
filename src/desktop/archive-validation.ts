import { z } from 'zod';
import { ACTUAL_SAMPLE_KEYS, ACTUAL_VALUE_KEYS, codePatternError } from '../shared/model.js';
import { fieldSchema, measurementSchema } from './validation.js';

const id = z.string().min(1).max(200),
  text = z.string().max(50000);
const time = z
  .string()
  .refine((value) => /(Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value)));
const values = z.record(z.string(), z.union([text, z.number().finite(), z.null()]));
const groupFields = {
  state: z.string().min(1).max(300),
  name: z.string().max(300).optional(),
  material: z.string().max(300).optional(),
  composition: z.string().max(3000).optional(),
  processing: z.string().max(3000).optional(),
  heatTreatment: z.string().max(3000).optional(),
  otherTreatment: z.string().max(3000).optional(),
  width: text.optional(),
  height: text.optional(),
  dimensionUnit: z.string().max(40).optional(),
  preparedCount: z.number().int().min(0).max(10000).nullable(),
  mode: z.enum(['未定', 'In situ', 'Ex situ']),
  priority: z.enum(['P0', 'P1', 'P2']),
  thickness: text,
  thicknessUnit: z.string().max(40),
  preparation: text,
  notes: text,
  protocol: text.optional(),
  values,
};
const group = z.object({
  id,
  experimentId: id,
  ...groupFields,
  order: z.number().int().nonnegative(),
  legacyCompleted: z.boolean().nullable(),
  legacyTime: text,
});
const sample = z.object({
  id,
  experimentId: id,
  groupId: id,
  code: z.string().min(1).max(400),
  values,
  parameters: z.object({ ...groupFields, state: z.string().max(300) }).partial(),
});
const item = z.object({
  id,
  experimentId: id,
  sampleId: id,
  operation: text,
  order: z.number().int().nonnegative(),
  status: z.enum(['pending', 'running', 'completed', 'skipped', 'interrupted']),
  repeatOf: id.optional(),
  measurement: measurementSchema.optional(),
  nameNumber: z.number().int().positive().optional(),
  plannedName: z.string().min(1).max(200).optional(),
  fieldNote: text.optional(),
});
const source = z.enum(['legacy', 'planned', 'edited']);
const actualSources = z
  .object({
    'actualSample.name': source.optional(),
    'actualSample.state': source.optional(),
    'actualSample.specimenName': source.optional(),
    'actualSample.width': source.optional(),
    'actualSample.height': source.optional(),
    'actualSample.dimensionUnit': source.optional(),
    'actual.thickness': source.optional(),
    'actual.thicknessUnit': source.optional(),
  })
  .strict();
const actualSample = z.object({
  name: z.string().max(300).optional(),
  state: z.string().max(300).optional(),
  specimenName: z.string().max(300).optional(),
  width: text.optional(),
  height: text.optional(),
  dimensionUnit: z.string().max(40).optional(),
});
const legacyActualSample = actualSample.extend({
  name: z.string().max(300),
  width: text,
  height: text,
  dimensionUnit: z.string().max(40),
});
const run = z.object({
  id,
  experimentId: id,
  itemId: id,
  sampleId: id,
  number: z.number().int().positive(),
  filename: text,
  startedAt: time.nullable(),
  endedAt: time.nullable(),
  originalStartedAt: time.nullable(),
  originalEndedAt: time.nullable(),
  timezone: z.string(),
  offsetMinutes: z.number().int().min(-840).max(840),
  snapshot: z.object({
    group: group.extend({ state: z.string().max(300) }),
    sampleGroupName: z.string().max(300).nullable().optional(),
    sample,
    operation: text,
    fields: z.array(fieldSchema).max(50),
    measurement: measurementSchema.optional(),
  }),
  actual: values,
  actualSample: actualSample.optional(),
  actualSources: actualSources.optional(),
  notes: text,
});
export const archiveSchema = z.object({
  schemaVersion: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  experiments: z.array(
    z.object({
      id,
      code: z.string().min(1).max(80),
      name: z.string().min(1).max(300),
      description: text,
      namingPattern: z.string().max(240),
      sampleCodePattern: z
        .string()
        .max(80)
        .refine((value) => codePatternError(value) === '', '编号样式无效。')
        .optional(),
      fields: z.array(fieldSchema).max(50),
      createdAt: time,
    }),
  ),
  groups: z.array(group),
  samples: z.array(sample),
  items: z.array(item),
  runs: z.array(run),
  events: z.array(
    z.object({
      id,
      experimentId: id,
      itemId: id.nullable(),
      runId: id.nullable(),
      type: text,
      text,
      createdAt: time,
      data: z.record(z.string(), z.unknown()),
    }),
  ),
  attachments: z.array(
    z.object({
      id,
      experimentId: id,
      runId: id,
      name: text,
      relativePath: z.string(),
      mime: z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp']),
      sha256: z.string(),
      size: z.number().int().positive(),
    }),
  ),
}).superRefine((archive, context) => {
  archive.runs.forEach((entry, index) => {
    if (archive.schemaVersion < 3) {
      if (entry.actualSources !== undefined ||
          (entry.actualSample !== undefined && !legacyActualSample.safeParse(entry.actualSample).success))
        context.addIssue({
          code: 'custom',
          path: ['runs', index, 'actualSample'],
          message: '旧版实际样品信息不符合旧数据格式。',
        });
      return;
    }
    for (const key of ACTUAL_SAMPLE_KEYS) {
      const field = `actualSample.${key}` as const;
      if (Boolean(entry.actualSample && Object.hasOwn(entry.actualSample, key)) !==
          Boolean(entry.actualSources?.[field]))
        context.addIssue({
          code: 'custom',
          path: ['runs', index, 'actualSources', field],
          message: '实际样品字段与其来源不一致。',
        });
    }
    for (const key of ACTUAL_VALUE_KEYS) {
      const field = `actual.${key}` as const;
      if (Object.hasOwn(entry.actual, key) !== Boolean(entry.actualSources?.[field]))
        context.addIssue({
          code: 'custom',
          path: ['runs', index, 'actualSources', field],
          message: '实际尺寸字段与其来源不一致。',
        });
    }
  });
});

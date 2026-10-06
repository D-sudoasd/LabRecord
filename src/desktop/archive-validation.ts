import { z } from 'zod';
import { fieldSchema } from './validation.js';

const id = z.string().min(1).max(200),
  text = z.string().max(50000);
const time = z
  .string()
  .refine((value) => /(Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value)));
const values = z.record(z.string(), z.union([text, z.number().finite(), z.null()]));
const groupFields = {
  state: z.string().min(1).max(300),
  name: z.string().max(300).optional(),
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
  parameters: z.object(groupFields).partial(),
});
const item = z.object({
  id,
  experimentId: id,
  sampleId: id,
  operation: text,
  order: z.number().int().nonnegative(),
  status: z.enum(['pending', 'running', 'completed', 'skipped', 'interrupted']),
  repeatOf: id.optional(),
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
  snapshot: z.object({ group, sample, operation: text, fields: z.array(fieldSchema).max(50) }),
  actual: values,
  actualSample: z
    .object({
      name: z.string().max(300),
      width: text,
      height: text,
      dimensionUnit: z.string().max(40),
    })
    .optional(),
  notes: text,
});
export const archiveSchema = z.object({
  schemaVersion: z.literal(1),
  experiments: z.array(
    z.object({
      id,
      code: z.string().min(1).max(80),
      name: z.string().min(1).max(300),
      description: text,
      namingPattern: z.string().max(240),
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
});

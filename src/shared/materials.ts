import type { GroupPatch } from './model.js';

export const MATERIAL_FIELDS = [
  {
    key: 'composition',
    label: '成分',
    placeholder: '如 Ti-24Nb-4Zr-8Sn（wt.%），请注明 wt.% 或 at.%',
    suggestions: [],
  },
  {
    key: 'processing',
    label: '加工工艺',
    placeholder: '如 铸态 → 热轧 → 冷轧 60%；未加工可填“无”',
    suggestions: ['无', '铸态', '热轧', '冷轧', '锻造', '挤压', '增材制造'],
  },
  {
    key: 'heatTreatment',
    label: '热处理制度',
    placeholder: '如 800 °C × 30 min，水淬 → 400 °C × 2 h 时效',
    suggestions: ['无', '退火', '固溶', '时效', '淬火', '回火'],
  },
  {
    key: 'otherTreatment',
    label: '其他工艺',
    placeholder: '如 高压扭转、激光冲击、表面处理等；没有可选“无”',
    suggestions: ['无', '高压扭转', '激光冲击', '表面处理', '电化学处理'],
  },
] as const;
export type MaterialKey = (typeof MATERIAL_FIELDS)[number]['key'];

export function materialSummary(group: GroupPatch) {
  return MATERIAL_FIELDS.filter(({ key }) => group[key]?.trim())
    .map(({ key, label }) => `${label}：${group[key]}`)
    .join(' · ');
}

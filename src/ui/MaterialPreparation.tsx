import { useId, type ReactNode } from 'react';
import type { GroupPatch } from '../shared/model';
import { MATERIAL_FIELDS, type MaterialKey } from '../shared/materials';

export function MaterialPreparationFields({
  value,
  onChange,
  label,
}: {
  value: GroupPatch;
  onChange: (key: MaterialKey, value: string) => void;
  label?: (key: string, title: string) => ReactNode;
}) {
  const id = useId();
  return (
    <fieldset className="form-section span-2 material-preparation-fields">
      <legend>材料与制备状态</legend>
      <div className="form-grid">
        {MATERIAL_FIELDS.map((field) => (
          <label className="field" key={field.key}>
            {label ? label(field.key, field.label) : <span>{field.label}</span>}
            <input
              aria-label={field.label}
              value={value[field.key] ?? ''}
              maxLength={3000}
              list={`${id}-${field.key}`}
              onChange={(event) => onChange(field.key, event.target.value)}
              placeholder={field.placeholder}
            />
            <datalist id={`${id}-${field.key}`}>
              {field.suggestions.map((option) => (
                <option key={option} value={option} />
              ))}
            </datalist>
            {(field.key === 'heatTreatment' || field.key === 'otherTreatment') && (
              <button
                type="button"
                className="text-button material-none"
                aria-label={`${field.label}设为无`}
                onClick={() => onChange(field.key, '无')}
              >
                选“无”
              </button>
            )}
          </label>
        ))}
      </div>
      <p className="hint">
        按制备先后填写工艺、温度、时间和冷却方式。留空表示未填写，“无”表示明确没有；现场加载或升温另填实验制度。
      </p>
    </fieldset>
  );
}

export function MaterialPreparationSummary({
  value,
  compact = false,
}: {
  value: GroupPatch;
  compact?: boolean;
}) {
  if (!MATERIAL_FIELDS.some(({ key }) => value[key]?.trim())) return null;
  return (
    <dl
      className={
        compact ? 'material-preparation-summary is-compact' : 'material-preparation-summary'
      }
      aria-label="材料与制备状态"
    >
      {MATERIAL_FIELDS.map(({ key, label }) => (
        <div key={key}>
          <dt>{label}</dt>
          <dd title={value[key]}>{value[key]?.trim() ? value[key] : '未填写'}</dd>
        </div>
      ))}
    </dl>
  );
}

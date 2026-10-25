import { useEffect, useId, useState, type ReactNode } from 'react';
import type { GroupPatch } from '../shared/model';
import { MATERIAL_FIELDS, type MaterialKey } from '../shared/materials';

export function MaterialPreparationFields({
  value,
  onChange,
  label,
  collapsible = false,
}: {
  value: GroupPatch;
  onChange: (key: MaterialKey, value: string) => void;
  label?: (key: string, title: string) => ReactNode;
  collapsible?: boolean;
}) {
  const id = useId();
  const hasValues = MATERIAL_FIELDS.some(({ key }) => value[key]?.trim());
  const [expanded, setExpanded] = useState(hasValues);
  useEffect(() => {
    if (hasValues) setExpanded(true);
  }, [hasValues]);
  const fields = (
    <>
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
            {(field.key === 'processing' || field.key === 'heatTreatment') &&
              (value[field.key] || '').includes('→') &&
              value[field.key] !== '无' && (
                <StepOrder
                  label={field.label}
                  value={value[field.key] || ''}
                  onChange={(next) => onChange(field.key, next)}
                />
              )}
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
    </>
  );
  if (collapsible) {
    return (
      <details
        className="span-2 quick-add-extra material-preparation-fields"
        open={expanded}
        onToggle={(event) => setExpanded(event.currentTarget.open)}
      >
        <summary>材料与制备状态（可选）{hasValues && ' · 已填写'}</summary>
        {fields}
      </details>
    );
  }
  return (
    <fieldset className="form-section span-2 material-preparation-fields">
      <legend>材料与制备状态</legend>
      {fields}
    </fieldset>
  );
}

function StepOrder({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const parts = value.split('→');
  function move(index: number, direction: -1 | 1) {
    const next = index + direction;
    if (next < 0 || next >= parts.length) return;
    const copy = [...parts];
    [copy[index], copy[next]] = [copy[next], copy[index]];
    onChange(copy.join('→'));
  }
  return (
    <div className="step-order" aria-label={`${label}工序顺序`}>
      {parts.map((part, index) => (
        <div key={`${index}-${part}`}>
          <span>{part.trim() || '（空）'}</span>
          <button
            type="button"
            className="text-button"
            aria-label={`${label}第 ${index + 1} 段上移`}
            disabled={index === 0}
            onClick={() => move(index, -1)}
          >
            上移
          </button>
          <button
            type="button"
            className="text-button"
            aria-label={`${label}第 ${index + 1} 段下移`}
            disabled={index === parts.length - 1}
            onClick={() => move(index, 1)}
          >
            下移
          </button>
        </div>
      ))}
    </div>
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

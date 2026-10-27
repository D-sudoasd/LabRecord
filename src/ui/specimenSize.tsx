import type { Group } from '../shared/model';

export type SpecimenSize = {
  thickness: string;
  thicknessUnit: string;
  width: string;
  height: string;
  dimensionUnit: string;
};

const UNITS = ['mm', 'μm', 'nm', 'cm'];

export function emptySpecimenSize(group?: Pick<Group, 'thicknessUnit' | 'dimensionUnit'>): SpecimenSize {
  return {
    thickness: '',
    thicknessUnit: group?.thicknessUnit || 'mm',
    width: '',
    height: '',
    dimensionUnit: group?.dimensionUnit || 'mm',
  };
}

export function SpecimenSizeFields({
  code,
  value,
  onChange,
}: {
  code: string;
  value: SpecimenSize;
  onChange: (next: SpecimenSize) => void;
}) {
  const set = (patch: Partial<SpecimenSize>) => onChange({ ...value, ...patch });
  return (
    <div className="dimension-fields">
      <label className="field">
        <span>{code} 厚度</span>
        <input
          aria-label={`${code} 厚度`}
          value={value.thickness}
          inputMode="decimal"
          placeholder="未填写"
          onChange={(event) => set({ thickness: event.target.value })}
        />
      </label>
      <label className="field">
        <span>{code} 厚度单位</span>
        <select
          aria-label={`${code} 厚度单位`}
          value={value.thicknessUnit}
          onChange={(event) => set({ thicknessUnit: event.target.value })}
        >
          <option value="">未指定</option>
          {UNITS.map((unit) => (
            <option key={unit}>{unit}</option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>{code} 宽度</span>
        <input
          aria-label={`${code} 宽度`}
          value={value.width}
          inputMode="decimal"
          placeholder="未填写"
          onChange={(event) => set({ width: event.target.value })}
        />
      </label>
      <label className="field">
        <span>{code} 高度</span>
        <input
          aria-label={`${code} 高度`}
          value={value.height}
          inputMode="decimal"
          placeholder="未填写"
          onChange={(event) => set({ height: event.target.value })}
        />
      </label>
      <label className="field">
        <span>{code} 宽高单位</span>
        <select
          aria-label={`${code} 宽高单位`}
          value={value.dimensionUnit}
          onChange={(event) => set({ dimensionUnit: event.target.value })}
        >
          <option value="">未指定</option>
          {UNITS.map((unit) => (
            <option key={unit}>{unit}</option>
          ))}
        </select>
      </label>
    </div>
  );
}

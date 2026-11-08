'use client';
import type { SettingSpec } from './types';

const NICE: Record<string, string> = {
  'minecraft:normal': 'Normal',
  'minecraft:flat': 'Superflat',
  'minecraft:large_biomes': 'Large biomes',
  'minecraft:amplified': 'Amplified (heavy on our small server!)',
};

export function SettingField({ spec, value, onChange, disabled }: { spec: SettingSpec; value: any; onChange: (v: any) => void; disabled?: boolean }) {
  if (spec.type === 'bool') {
    return (
      <label className="check field">
        <input type="checkbox" checked={!!value} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
        <span>{spec.label}</span>
      </label>
    );
  }
  return (
    <label className="field">
      <span>
        {spec.label}
        {spec.type === 'int' && <span className="muted"> ({spec.min}–{spec.max})</span>}
      </span>
      {spec.type === 'enum' ? (
        <select className="input" value={String(value)} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
          {spec.values!.map((v) => (
            <option key={v} value={v}>{NICE[v] || v[0].toUpperCase() + v.slice(1)}</option>
          ))}
        </select>
      ) : spec.type === 'int' ? (
        <input className="input" type="number" min={spec.min} max={spec.max} value={value ?? ''} disabled={disabled} onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))} />
      ) : (
        <input className="input" maxLength={spec.max} value={value ?? ''} disabled={disabled} onChange={(e) => onChange(e.target.value)} />
      )}
    </label>
  );
}

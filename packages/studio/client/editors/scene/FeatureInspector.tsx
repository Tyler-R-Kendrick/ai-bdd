import type { CadFeature } from '../../../shared/cad-domain.ts';
import { Field, Select } from '../../components/ui.tsx';

export function FeatureInspector({
  feature,
  disabled,
  unit,
  onChange,
}: {
  feature: CadFeature;
  disabled: boolean;
  unit: string;
  onChange: (feature: CadFeature) => void;
}) {
  const number = (
    key: 'width' | 'height' | 'radius' | 'depth' | 'offset' | 'fillet',
    label: string,
    min: number,
  ) => (
    <Field label={`${label} (${unit})`}>
      <input
        aria-label={`Feature ${label.toLowerCase()}`}
        type="number"
        min={min}
        max={100000}
        step="any"
        value={feature[key]}
        disabled={disabled}
        onChange={(event) => {
          const value = event.currentTarget.valueAsNumber;
          if (Number.isFinite(value) && value >= min && value <= 100000)
            onChange({ ...feature, [key]: value });
        }}
      />
    </Field>
  );
  const width =
    feature.profile === 'circle' ? feature.radius * 2 : feature.width;
  const height =
    feature.profile === 'circle' ? feature.radius * 2 : feature.height;
  const extent = Math.max(width, height) * 1.5;
  return (
    <div className="cad-feature-inspector">
      <Field label="Feature name">
        <input
          aria-label="Feature name"
          value={feature.name}
          maxLength={120}
          disabled={disabled}
          onChange={(event) =>
            onChange({
              ...feature,
              name: event.target.value || 'Sketch extrusion',
            })
          }
        />
      </Field>
      <svg
        className="cad-sketch-preview"
        role="img"
        aria-label={`Dimension-driven ${feature.profile} sketch`}
        viewBox={`${-extent / 2} ${-extent / 2} ${extent} ${extent}`}
      >
        <line
          x1={-extent / 2}
          x2={extent / 2}
          y1={0}
          y2={0}
          className="cad-sketch-axis"
        />
        <line
          y1={-extent / 2}
          y2={extent / 2}
          x1={0}
          x2={0}
          className="cad-sketch-axis"
        />
        {feature.profile === 'circle' ? (
          <circle cx={0} cy={0} r={feature.radius} />
        ) : (
          <rect x={-width / 2} y={-height / 2} width={width} height={height} />
        )}
      </svg>
      <p className="cad-constraint-note">
        Dimension-driven profile ·{' '}
        {feature.profile === 'circle'
          ? `R ${feature.radius}`
          : `${feature.width} × ${feature.height}`}{' '}
        {unit}
      </p>
      <Field label="Sketch plane">
        <Select
          value={feature.plane}
          disabled={disabled}
          onChange={(event) =>
            onChange({
              ...feature,
              plane: event.target.value as CadFeature['plane'],
            })
          }
        >
          <option>XY</option>
          <option>XZ</option>
          <option>YZ</option>
        </Select>
      </Field>
      {feature.profile === 'circle' ? (
        number('radius', 'Radius', 0.01)
      ) : (
        <>
          {number('width', 'Width', 0.01)}
          {number('height', 'Height', 0.01)}
        </>
      )}
      <div className="scene-axis-inputs">
        {feature.center.map((value, index) => (
          <label key={index}>
            {index ? 'V' : 'U'}
            <input
              type="number"
              aria-label={`Sketch center ${index ? 'V' : 'U'}`}
              value={value}
              min={-100000}
              max={100000}
              disabled={disabled}
              onChange={(event) => {
                const coordinate = event.currentTarget.valueAsNumber;
                if (
                  !Number.isFinite(coordinate) ||
                  Math.abs(coordinate) > 100000
                )
                  return;
                const center = [...feature.center] as [number, number];
                center[index] = coordinate;
                onChange({ ...feature, center });
              }}
            />
          </label>
        ))}
      </div>
      {number('offset', 'Plane offset', -100000)}
      {number('depth', 'Depth', 0.01)}
      {number('fillet', 'Edge fillet', 0)}
      <Field label="Feature operation">
        <Select
          value={feature.operation}
          disabled={disabled}
          onChange={(event) =>
            onChange({
              ...feature,
              operation: event.target.value as CadFeature['operation'],
            })
          }
        >
          <option value="union">Add material</option>
          <option value="subtract">Remove material</option>
          <option value="intersect">Keep overlap</option>
        </Select>
      </Field>
      <label className="scene-check">
        <input
          type="checkbox"
          checked={feature.enabled}
          disabled={disabled}
          onChange={(event) =>
            onChange({ ...feature, enabled: event.target.checked })
          }
        />
        Enable feature
      </label>
    </div>
  );
}

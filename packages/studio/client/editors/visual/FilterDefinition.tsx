import {
  grayscaleMatrix,
  type LayerAppearance,
} from '../../../shared/visual-design.ts';

export default function FilterDefinition({
  id,
  filters,
  width,
  height,
}: {
  id: string;
  filters: NonNullable<LayerAppearance['filters']>;
  width: number;
  height: number;
}) {
  const slope = filters.brightness * filters.contrast,
    intercept = (1 - filters.contrast) / 2,
    margin = Math.ceil(filters.blur * 3);
  return (
    <filter
      id={id}
      filterUnits="userSpaceOnUse"
      primitiveUnits="userSpaceOnUse"
      x={-margin}
      y={-margin}
      width={width + 2 * margin}
      height={height + 2 * margin}
      colorInterpolationFilters="sRGB"
    >
      <feComponentTransfer>
        <feFuncR type="linear" slope={slope} intercept={intercept} />
        <feFuncG type="linear" slope={slope} intercept={intercept} />
        <feFuncB type="linear" slope={slope} intercept={intercept} />
      </feComponentTransfer>
      <feColorMatrix type="saturate" values={String(filters.saturation)} />
      <feColorMatrix
        type="matrix"
        values={grayscaleMatrix(filters.grayscale)}
      />
      <feGaussianBlur stdDeviation={filters.blur} />
    </filter>
  );
}

import { pathData } from '../../../shared/visual-design.ts';
import FilterDefinition from './FilterDefinition.tsx';
import { layerFont, layerLines, type Layer } from './render.ts';
export default function LayerShape({
  layer,
  measure,
}: {
  layer: Layer;
  measure: (layer: Layer, text: string) => number;
}) {
  const clip = 'appearance-' + layer.id,
    crop = layer.crop ?? { x: 0, y: 0, width: 1, height: 1 };
  return (
    <>
      {(layer.filters ||
        layer.mask === 'ellipse' ||
        (layer.mask === 'path' && layer.path)) && (
        <defs>
          {layer.filters && (
            <FilterDefinition
              id={clip + '-filter'}
              filters={layer.filters}
              width={layer.width}
              height={layer.height}
            />
          )}
          <clipPath id={clip}>
            {layer.mask === 'ellipse' ? (
              <ellipse
                cx={layer.width / 2}
                cy={layer.height / 2}
                rx={layer.width / 2}
                ry={layer.height / 2}
              />
            ) : (
              layer.path && (
                <path
                  d={pathData(layer.path)}
                  transform={`scale(${layer.width / layer.path.viewWidth} ${layer.height / layer.path.viewHeight})`}
                />
              )
            )}
          </clipPath>
        </defs>
      )}
      <g
        opacity={layer.opacity ?? 1}
        filter={layer.filters ? `url(#${clip}-filter)` : undefined}
        clipPath={
          layer.mask && layer.mask !== 'none' ? `url(#${clip})` : undefined
        }
      >
        {layer.type === 'image' ? (
          <svg
            width={layer.width}
            height={layer.height}
            viewBox={`${crop.x} ${crop.y} ${crop.width} ${crop.height}`}
            preserveAspectRatio="none"
            overflow="hidden"
          >
            <image
              href={layer.src}
              width={1}
              height={1}
              preserveAspectRatio="none"
            />
          </svg>
        ) : layer.type === 'path' && layer.path ? (
          <svg
            width={layer.width}
            height={layer.height}
            viewBox={`0 0 ${layer.path.viewWidth} ${layer.path.viewHeight}`}
            preserveAspectRatio="none"
          >
            <path
              d={pathData(layer.path)}
              fill={layer.path.closed ? layer.fill : 'none'}
              stroke={layer.stroke ?? layer.fill}
              strokeWidth={layer.strokeWidth ?? (layer.path.closed ? 0 : 2)}
            />
          </svg>
        ) : layer.type === 'rect' ? (
          <rect
            width={layer.width}
            height={layer.height}
            fill={layer.fill}
            stroke={layer.stroke ?? layer.fill}
            strokeWidth={layer.strokeWidth ?? 0}
          />
        ) : layer.type === 'ellipse' ? (
          <ellipse
            cx={layer.width / 2}
            cy={layer.height / 2}
            rx={layer.width / 2}
            ry={layer.height / 2}
            fill={layer.fill}
            stroke={layer.stroke ?? layer.fill}
            strokeWidth={layer.strokeWidth ?? 0}
          />
        ) : (
          <>
            <defs>
              <clipPath id={'editor-clip-' + layer.id}>
                <rect width={layer.width} height={layer.height} />
              </clipPath>
            </defs>
            <rect
              width={layer.width}
              height={layer.height}
              fill="transparent"
            />
            <text
              fontFamily={layerFont(layer)}
              fontSize={layer.fontSize}
              fill={layer.fill}
              clipPath={`url(#editor-clip-${layer.id})`}
              style={{ userSelect: 'none' }}
            >
              {layerLines(layer, (text) => measure(layer, text)).map(
                (line, index) => (
                  <tspan
                    key={index}
                    x={0}
                    y={layer.fontSize * (0.85 + index * 1.2)}
                  >
                    {line}
                  </tspan>
                ),
              )}
            </text>
          </>
        )}
      </g>
    </>
  );
}

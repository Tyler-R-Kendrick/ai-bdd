import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type PropsWithChildren,
} from 'react';
import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react';
import {
  ChartColumn,
  ChartLine,
  Code2,
  GitBranch,
  LayoutPanelTop,
  Trash2,
} from 'lucide-react';
import { Badge, Button, Modal, Textarea } from '../../components/ui.tsx';
import {
  assertRichVisualUnchanged,
  chartRange,
  richVisualSchemas,
  type ChartData,
  type DiagramData,
  type TabsData,
  type RichVisualKind,
} from '../../../shared/rich-blocks.ts';
import './blocks.css';

function Chart({ data }: { data: ChartData }) {
  const container = useRef<HTMLDivElement>(null),
    [width, setWidth] = useState(640);
  useEffect(() => {
    const measure = () =>
      setWidth(
        Math.max(280, Math.min(640, container.current?.clientWidth ?? 640)),
      );
    measure();
    const observer = new ResizeObserver(measure);
    if (container.current) observer.observe(container.current);
    return () => observer.disconnect();
  }, []);
  const [selected, setSelected] = useState<number | null>(null),
    { min, max } = chartRange(data.points),
    height = 240,
    left = 45,
    top = 20,
    plotWidth = width - left - 20,
    plotHeight = height - top - 45;
  const x = (index: number) =>
      left + ((index + 0.5) * plotWidth) / data.points.length,
    y = (value: number) => top + ((max - value) / (max - min)) * plotHeight,
    zero = y(0),
    barWidth = Math.min(62, (plotWidth / data.points.length) * 0.62);
  const picked = selected === null ? null : data.points[selected];
  return (
    <div className="rich-chart" ref={container}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`${data.kind === 'bar' ? 'Bar' : 'Line'} chart: ${data.title}`}
      >
        <title>{data.title}</title>
        <desc>
          {data.points
            .map((point) => `${point.label}: ${point.value}`)
            .join('; ')}
        </desc>
        {[min, (min + max) / 2, max].map((value, index) => (
          <g key={index}>
            <line
              x1={left}
              x2={width - 20}
              y1={y(value)}
              y2={y(value)}
              stroke="#e7e8e3"
            />
            <text
              x={left - 9}
              y={y(value) + 4}
              textAnchor="end"
              className="rich-chart-tick"
            >
              {new Intl.NumberFormat(undefined, {
                notation: 'compact',
                maximumFractionDigits: 1,
              }).format(value)}
            </text>
          </g>
        ))}
        <line x1={left} x2={width - 20} y1={zero} y2={zero} stroke="#c7cac1" />
        {data.kind === 'line' && (
          <path
            d={data.points
              .map(
                (point, index) =>
                  `${index === 0 ? 'M' : 'L'} ${x(index)} ${y(point.value)}`,
              )
              .join(' ')}
            fill="none"
            stroke="#6b73d1"
            strokeWidth={2.5}
          />
        )}
        {data.points.map((point, index) => (
          <g
            key={index}
            tabIndex={0}
            role="button"
            aria-label={`${point.label}: ${point.value}`}
            aria-pressed={selected === index}
            className="rich-chart-point"
            onMouseEnter={() => setSelected(index)}
            onClick={() => setSelected(index)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                setSelected(index);
              }
            }}
          >
            {data.kind === 'bar' ? (
              <rect
                x={x(index) - barWidth / 2}
                y={Math.min(zero, y(point.value))}
                width={barWidth}
                height={Math.max(1, Math.abs(y(point.value) - zero))}
                rx={2}
                fill={selected === index ? '#4e579e' : '#7b83cf'}
              />
            ) : (
              <circle
                cx={x(index)}
                cy={y(point.value)}
                r={selected === index ? 6 : 4}
                fill="#6b73d1"
                stroke="white"
                strokeWidth={2}
              />
            )}
            {index %
              Math.ceil(
                data.points.length / Math.max(1, Math.floor(plotWidth / 65)),
              ) ===
              0 && (
              <text
                x={x(index)}
                y={height - 11}
                textAnchor="middle"
                className="rich-chart-tick"
              >
                {point.label.length > 14
                  ? point.label.slice(0, 12) + '…'
                  : point.label}
              </text>
            )}
          </g>
        ))}
      </svg>
      <div className="rich-chart-readout" aria-live="polite">
        {picked ? (
          <>
            <strong>{picked.label}</strong>
            <span>{new Intl.NumberFormat().format(picked.value)}</span>
          </>
        ) : (
          <span>Select a data point to inspect its value.</span>
        )}
      </div>
      <details className="rich-data-table">
        <summary>View data table</summary>
        <table>
          <thead>
            <tr>
              <th>Label</th>
              <th>Value</th>
            </tr>
          </thead>
          <tbody>
            {data.points.map((point, index) => (
              <tr key={index}>
                <td>{point.label}</td>
                <td>{point.value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}
function Diagram({ data }: { data: DiagramData }) {
  const id = useId().replace(/:/g, ''),
    [active, setActive] = useState<string | null>(null),
    nodes = new Map(data.nodes.map((node) => [node.id, node]));
  const top = Math.max(0, Math.min(...data.nodes.map((node) => node.y)) - 50),
    height = Math.max(
      160,
      Math.max(...data.nodes.map((node) => node.y)) + 110 - top,
    );
  return (
    <div className="rich-diagram">
      <div
        className="rich-diagram-scroll"
        tabIndex={0}
        aria-label="Scrollable diagram"
      >
        <svg
          viewBox={`0 ${top} 800 ${height}`}
          role="img"
          aria-label={`Diagram: ${data.title}`}
        >
          <title>{data.title}</title>
          <desc>
            {data.edges
              .map(
                (edge) =>
                  `${nodes.get(edge.from)?.label} to ${nodes.get(edge.to)?.label}${edge.label ? ': ' + edge.label : ''}`,
              )
              .join('; ')}
          </desc>
          <defs>
            <marker
              id={id + 'arrow'}
              markerWidth="8"
              markerHeight="8"
              refX="7"
              refY="4"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 8 4 L 0 8 z" fill="#9da498" />
            </marker>
          </defs>
          {data.edges.map((edge, index) => {
            const from = nodes.get(edge.from)!,
              to = nodes.get(edge.to)!,
              fromX = from.x + 70,
              fromY = from.y + 25,
              toX = to.x + 70,
              toY = to.y + 25,
              dx = toX - fromX,
              dy = toY - fromY;
            const ratio = Math.max(Math.abs(dx) / 70, Math.abs(dy) / 25, 1),
              startX = fromX + dx / ratio,
              startY = fromY + dy / ratio,
              endX = toX - dx / ratio,
              endY = toY - dy / ratio;
            return (
              <g key={index}>
                <path
                  d={`M ${startX} ${startY} L ${endX} ${endY}`}
                  stroke={
                    active === edge.from || active === edge.to
                      ? '#6b73d1'
                      : '#9da498'
                  }
                  strokeWidth={1.5}
                  markerEnd={`url(#${id}arrow)`}
                />
                {edge.label && (
                  <text
                    x={(startX + endX) / 2}
                    y={(startY + endY) / 2 - 9}
                    textAnchor="middle"
                    className="rich-diagram-edge"
                  >
                    {edge.label.length > 30
                      ? edge.label.slice(0, 28) + '…'
                      : edge.label}
                  </text>
                )}
              </g>
            );
          })}
          {data.nodes.map((node) => (
            <g
              key={node.id}
              tabIndex={0}
              role="button"
              aria-label={node.label}
              aria-pressed={active === node.id}
              onClick={() => setActive(node.id)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  setActive(node.id);
                }
              }}
              className="rich-diagram-node"
            >
              <rect
                x={node.x}
                y={node.y}
                width={140}
                height={50}
                rx={6}
                fill={active === node.id ? '#ecedf6' : '#f7f8f3'}
                stroke={active === node.id ? '#6b73d1' : '#d0d5c9'}
              />
              <text
                x={node.x + 70}
                y={node.y + 29}
                textAnchor="middle"
                className="rich-diagram-label"
              >
                {node.label.length > 22
                  ? node.label.slice(0, 20) + '…'
                  : node.label}
              </text>
            </g>
          ))}
        </svg>
      </div>
      <div className="rich-chart-readout" aria-live="polite">
        {active ? (
          <span>
            {nodes.get(active)?.label} ·{' '}
            {
              data.edges.filter(
                (edge) => edge.from === active || edge.to === active,
              ).length
            }{' '}
            connections
          </span>
        ) : (
          <span>
            Select a node to inspect its connections. Scroll to explore wider
            diagrams.
          </span>
        )}
      </div>
    </div>
  );
}
function Tabs({ data }: { data: TabsData }) {
  const id = useId().replace(/:/g, ''),
    [selected, setSelected] = useState(data.tabs[0]!.id),
    active = data.tabs.find((tab) => tab.id === selected) ?? data.tabs[0]!;
  return (
    <div className="rich-tabs">
      <div role="tablist" aria-label={data.title}>
        {data.tabs.map((tab, index) => (
          <button
            type="button"
            role="tab"
            key={tab.id}
            id={`${id}-${tab.id}-tab`}
            aria-controls={`${id}-${tab.id}-panel`}
            aria-selected={active.id === tab.id}
            tabIndex={active.id === tab.id ? 0 : -1}
            onClick={() => setSelected(tab.id)}
            onKeyDown={(event) => {
              const step =
                event.key === 'ArrowRight'
                  ? 1
                  : event.key === 'ArrowLeft'
                    ? -1
                    : 0;
              if (step) {
                event.preventDefault();
                const next =
                  data.tabs[
                    (index + step + data.tabs.length) % data.tabs.length
                  ]!;
                setSelected(next.id);
                document.getElementById(`${id}-${next.id}-tab`)?.focus();
              }
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={`${id}-${active.id}-panel`}
        aria-labelledby={`${id}-${active.id}-tab`}
        tabIndex={0}
      >
        {active.body.split('\n\n').map((text, index) => (
          <p key={index}>{text}</p>
        ))}
      </div>
    </div>
  );
}
type EditSession = {
  kind: RichVisualKind;
  value: unknown;
  save: (value: unknown) => void;
  remove: () => void;
};
const EditContext = createContext<{
  open: (session: EditSession) => void;
  readOnly: boolean;
} | null>(null);
export function RichVisualProvider({
  children,
  readOnly = false,
}: PropsWithChildren<{ readOnly?: boolean }>) {
  const [session, setSession] = useState<EditSession | null>(null),
    [source, setSource] = useState(''),
    [error, setError] = useState('');
  function open(next: EditSession) {
    if (readOnly) return;
    setSource(JSON.stringify(next.value, null, 2));
    setError('');
    setSession(next);
  }
  return (
    <EditContext.Provider value={{ open, readOnly }}>
      {children}
      <Modal
        open={session !== null}
        onOpenChange={(value) => {
          if (!value) setSession(null);
        }}
        title={`Edit ${session?.kind === 'chartBlock' ? 'chart' : session?.kind === 'diagramBlock' ? 'diagram' : 'tabs'}`}
        description="Visual blocks use structured data. Scripts, HTML, and arbitrary components are not executed."
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!session || readOnly) return;
            try {
              const data = richVisualSchemas[session.kind].parse(
                JSON.parse(source),
              );
              session.save(data);
              setSession(null);
            } catch (e) {
              setError(e instanceof Error ? e.message : 'Invalid block data');
            }
          }}
        >
          <label className="field">
            <span>Block data · JSON</span>
            <Textarea
              className="rich-source-editor"
              value={source}
              onChange={(event) => setSource(event.target.value)}
              spellCheck={false}
              aria-label="Visual block JSON"
              required
              disabled={readOnly}
            />
          </label>
          {error && (
            <p className="rich-block-error" role="alert">
              {error}
            </p>
          )}
          <div className="dialog-footer">
            <Button
              type="button"
              variant="ghost"
              disabled={readOnly}
              onClick={() => {
                try {
                  session?.remove();
                  setSession(null);
                } catch (error) {
                  setError(
                    error instanceof Error
                      ? error.message
                      : 'The block could not be removed.',
                  );
                }
              }}
            >
              <Trash2 size={13} />
              Remove block
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => setSession(null)}
            >
              Cancel
            </Button>
            <Button disabled={readOnly}>Save block</Button>
          </div>
        </form>
      </Modal>
    </EditContext.Provider>
  );
}
export function RichVisualView({ node, editor, getPos }: NodeViewProps) {
  const kind = node.type.name as RichVisualKind,
    schema = richVisualSchemas[kind],
    parsed = schema.safeParse(node.attrs.data);
  const editing = useContext(EditContext);
  const Icon =
    kind === 'chartBlock'
      ? parsed.success && 'kind' in parsed.data && parsed.data.kind === 'line'
        ? ChartLine
        : ChartColumn
      : kind === 'diagramBlock'
        ? GitBranch
        : LayoutPanelTop;
  function openEditor() {
    if (!editing || !editor.isEditable) return;
    const original = getPos();
    if (typeof original !== 'number') return;
    const anchor = String(node.attrs.id || crypto.randomUUID());
    const opening = structuredClone(node.attrs.data);
    editor.commands.command(({ tr }) => {
      const current = tr.doc.nodeAt(original);
      if (current?.type.name !== kind) return false;
      tr.setNodeMarkup(original, undefined, { ...current.attrs, id: anchor });
      return true;
    });
    // Resolve the durable block ID when the dialog commits. A NodeView itself may be replaced on blur or by a remote edit.
    const update = (data: unknown, remove = false) => {
      if (!editor.isEditable)
        throw new Error(
          'Your editing access changed. Your typed source is retained; copy it before closing this dialog.',
        );
      let found = false;
      editor.commands.command(({ tr }) => {
        let position: number | undefined;
        tr.doc.descendants((current, pos) => {
          if (current.type.name === kind && current.attrs.id === anchor) {
            position = pos;
            return false;
          }
          return true;
        });
        if (position === undefined) return false;
        const current = tr.doc.nodeAt(position)!;
        assertRichVisualUnchanged(kind, opening, current.attrs.data);
        if (remove) tr.delete(position, position + current.nodeSize);
        else tr.setNodeMarkup(position, undefined, { ...current.attrs, data });
        found = true;
        return true;
      });
      if (!found)
        throw new Error(
          'This block was removed while you were editing it. Close the dialog and reload the document.',
        );
    };
    editing.open({
      kind,
      value: opening,
      save: (data) => update(data),
      remove: () => update(undefined, true),
    });
  }
  return (
    <NodeViewWrapper
      className="rich-visual-block"
      contentEditable={false}
      data-visual-kind={kind}
    >
      <div className="rich-visual-heading">
        <Icon size={17} />
        <strong>
          {parsed.success ? parsed.data.title : 'Invalid visual block'}
        </strong>
        <Badge>
          {kind === 'chartBlock'
            ? 'Chart'
            : kind === 'diagramBlock'
              ? 'Diagram'
              : 'Tabs'}
        </Badge>
        {editor.isEditable && editing && !editing.readOnly && (
          <Button size="sm" variant="ghost" onClick={openEditor}>
            <Code2 size={13} />
            Edit
          </Button>
        )}
      </div>
      {parsed.success ? (
        <>
          {'description' in parsed.data && parsed.data.description && (
            <p className="rich-visual-description">{parsed.data.description}</p>
          )}
          {kind === 'chartBlock' ? (
            <Chart data={parsed.data as ChartData} />
          ) : kind === 'diagramBlock' ? (
            <Diagram data={parsed.data as DiagramData} />
          ) : (
            <Tabs data={parsed.data as TabsData} />
          )}
        </>
      ) : (
        <p className="rich-block-error">
          This block does not match its bounded schema. An editor can repair its
          source.
        </p>
      )}
    </NodeViewWrapper>
  );
}

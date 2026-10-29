import { useEffect, useRef, useState } from "react";
import { Check, MousePointer2, PenLine, Plus, Trash2 } from "lucide-react";
import { Button, Field, Input } from "../../components/ui.tsx";
import {
  pathData,
  type DesignPoint,
  type VectorPath,
} from "../../../shared/visual-design.ts";

type Props = {
  value: VectorPath;
  onChange: (path: VectorPath) => void;
  readOnly: boolean;
  fill?: string;
  label?: string;
  baseline?: number;
};
export default function PathDesigner({
  value,
  onChange,
  readOnly,
  fill = "#6b73d1",
  label = "Vector outline",
  baseline,
}: Props) {
  const [tool, setTool] = useState<"select" | "pen">("select"),
    [pending, setPending] = useState<DesignPoint[]>([]),
    [selected, setSelected] = useState<[number, number] | null>(null),
    [dragged, setDragged] = useState<VectorPath | null>(null),
    [snap, setSnap] = useState(true);
  const svg = useRef<SVGSVGElement>(null),
    drag = useRef<{
      pointer: number;
      selection: [number, number];
      path: VectorPath;
    } | null>(null);
  useEffect(() => {
    setSelected(null);
    setPending([]);
    setDragged(null);
  }, [label]);
  const current = dragged ?? value;
  const point = (event: React.PointerEvent): DesignPoint => {
    const box = svg.current!.getBoundingClientRect(),
      step = snap ? value.viewWidth / 100 : 1;
    return {
      x:
        Math.round(
          (((event.clientX - box.left) / box.width) * value.viewWidth) / step,
        ) * step,
      y:
        Math.round(
          (((event.clientY - box.top) / box.height) * value.viewHeight) / step,
        ) * step,
    };
  };
  function finish() {
    if (pending.length < 2 || readOnly) return;
    onChange({ ...value, contours: [...value.contours, pending] });
    setPending([]);
    setTool("select");
  }
  function updatePoint(patch: Partial<DesignPoint>) {
    if (!selected || readOnly) return;
    const next = structuredClone(value);
    Object.assign(next.contours[selected[0]]![selected[1]]!, patch);
    onChange(next);
  }
  const selectedPoint = selected
    ? current.contours[selected[0]]?.[selected[1]]
    : undefined;
  return (
    <section className="design-outline" aria-label={label}>
      <div className="design-outline-heading">
        <h3>{label}</h3>
        <span>{current.contours.length} contours</span>
      </div>
      <div
        className="design-outline-tools"
        role="toolbar"
        aria-label="Outline tools"
      >
        <Button
          size="sm"
          variant={tool === "select" ? "secondary" : "ghost"}
          onClick={() => {
            setTool("select");
            setPending([]);
          }}
        >
          <MousePointer2 size={13} />
          Select points
        </Button>
        <Button
          size="sm"
          variant={tool === "pen" ? "secondary" : "ghost"}
          disabled={readOnly || value.contours.length >= 64}
          onClick={() => {
            setTool("pen");
            setSelected(null);
          }}
        >
          <PenLine size={13} />
          Draw contour
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={readOnly || pending.length < 2}
          onClick={finish}
        >
          <Check size={13} />
          Finish contour
        </Button>
        <label className="design-snap">
          <input
            type="checkbox"
            checked={snap}
            onChange={(e) => setSnap(e.target.checked)}
          />
          Snap
        </label>
      </div>
      <svg
        ref={svg}
        className={"design-outline-canvas " + (tool === "pen" ? "drawing" : "")}
        viewBox={`0 0 ${value.viewWidth} ${value.viewHeight}`}
        aria-label={`${label} point canvas`}
        role="img"
        tabIndex={0}
        onPointerDown={(e) => {
          if (tool === "pen" && !readOnly) {
            e.preventDefault();
            if (pending.length < 256) setPending((p) => [...p, point(e)]);
          }
        }}
        onPointerMove={(e) => {
          if (!drag.current || drag.current.pointer !== e.pointerId) return;
          const next = structuredClone(drag.current.path),
            p = point(e);
          Object.assign(
            next.contours[drag.current.selection[0]]![
              drag.current.selection[1]
            ]!,
            p,
          );
          drag.current.path = next;
          setDragged(next);
        }}
        onPointerUp={(e) => {
          if (drag.current?.pointer !== e.pointerId) return;
          onChange(drag.current.path);
          drag.current = null;
          setDragged(null);
          if (svg.current?.hasPointerCapture(e.pointerId))
            svg.current.releasePointerCapture(e.pointerId);
        }}
        onPointerCancel={() => {
          drag.current = null;
          setDragged(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            setPending([]);
            setTool("select");
          }
          if (e.key === "Enter" && tool === "pen") {
            e.preventDefault();
            finish();
          }
          if (!selectedPoint || readOnly || !selected) return;
          if (
            ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)
          ) {
            e.preventDefault();
            const delta = e.shiftKey ? 10 : 1;
            updatePoint({
              x:
                selectedPoint.x +
                (e.key === "ArrowLeft"
                  ? -delta
                  : e.key === "ArrowRight"
                    ? delta
                    : 0),
              y:
                selectedPoint.y +
                (e.key === "ArrowUp"
                  ? -delta
                  : e.key === "ArrowDown"
                    ? delta
                    : 0),
            });
          }
        }}
      >
        <title>
          {label}: select and move outline points or draw a new contour
        </title>
        <defs>
          <pattern
            id={`point-grid-${label.replace(/\W/g, "")}`}
            width={value.viewWidth / 10}
            height={value.viewHeight / 10}
            patternUnits="userSpaceOnUse"
          >
            <path
              d={`M ${value.viewWidth / 10} 0 L 0 0 0 ${value.viewHeight / 10}`}
              fill="none"
              stroke="#dfe3da"
              strokeWidth={value.viewWidth / 600}
            />
          </pattern>
        </defs>
        <rect
          width={value.viewWidth}
          height={value.viewHeight}
          fill={`url(#point-grid-${label.replace(/\W/g, "")})`}
        />
        {baseline !== undefined && (
          <line
            x1={0}
            x2={value.viewWidth}
            y1={baseline}
            y2={baseline}
            stroke="#ad6c42"
            strokeWidth={value.viewWidth / 450}
          />
        )}
        <path
          d={pathData(current)}
          fill={current.closed ? fill : "none"}
          fillRule="nonzero"
          stroke={fill}
          strokeWidth={current.closed ? 0 : value.viewWidth / 80}
        />
        {current.contours.flatMap((contour, ci) =>
          contour.map((p, pi) => (
            <circle
              key={`${ci}-${pi}`}
              cx={p.x}
              cy={p.y}
              r={value.viewWidth / 130}
              fill={
                selected?.[0] === ci && selected?.[1] === pi
                  ? "#555ca8"
                  : p.onCurve === false
                    ? "#dfb955"
                    : "#ffffff"
              }
              stroke="#555ca8"
              strokeWidth={value.viewWidth / 500}
              className="design-outline-point"
              aria-label={`Contour ${ci + 1} point ${pi + 1}`}
              onPointerDown={(e) => {
                if (tool === "pen" || readOnly) return;
                e.preventDefault();
                e.stopPropagation();
                setSelected([ci, pi]);
                drag.current = {
                  pointer: e.pointerId,
                  selection: [ci, pi],
                  path: structuredClone(value),
                };
                svg.current?.setPointerCapture(e.pointerId);
              }}
            />
          )),
        )}
        {pending.length > 0 && (
          <>
            <polyline
              points={pending.map((p) => `${p.x},${p.y}`).join(" ")}
              fill="none"
              stroke="#555ca8"
              strokeWidth={value.viewWidth / 350}
            />
            {pending.map((p, i) => (
              <circle
                key={i}
                cx={p.x}
                cy={p.y}
                r={value.viewWidth / 150}
                fill="#555ca8"
              />
            ))}
          </>
        )}
      </svg>
      <div className="design-outline-footer">
        <p>
          {tool === "pen"
            ? "Click points, then finish the contour. Enter finishes; Escape cancels."
            : "Drag a point or use arrow keys. Shift moves ten units. Gold points control a quadratic curve."}
        </p>
        <Button
          size="sm"
          variant="ghost"
          disabled={readOnly || !selected}
          onClick={() => {
            if (!selected) return;
            const next = structuredClone(value),
              contour = next.contours[selected[0]]!;
            if (contour.length <= 3) {
              if (next.contours.length === 1) return;
              next.contours.splice(selected[0], 1);
            } else contour.splice(selected[1], 1);
            onChange(next);
            setSelected(null);
          }}
        >
          <Trash2 size={13} />
          Delete point
        </Button>
      </div>
      {selectedPoint && (
        <div className="design-point-fields">
          <Field label="Point X">
            <Input
              aria-label="Outline point X"
              type="number"
              value={selectedPoint.x}
              disabled={readOnly}
              onChange={(e) => {
                const x = Number(e.target.value);
                if (Number.isFinite(x) && Math.abs(x) <= 10000)
                  updatePoint({ x });
              }}
            />
          </Field>
          <Field label="Point Y">
            <Input
              aria-label="Outline point Y"
              type="number"
              value={selectedPoint.y}
              disabled={readOnly}
              onChange={(e) => {
                const y = Number(e.target.value);
                if (Number.isFinite(y) && Math.abs(y) <= 10000)
                  updatePoint({ y });
              }}
            />
          </Field>
          <label>
            <input
              type="checkbox"
              checked={selectedPoint.onCurve !== false}
              disabled={readOnly}
              onChange={(e) => updatePoint({ onCurve: e.target.checked })}
            />
            On-curve point
          </label>
        </div>
      )}
    </section>
  );
}

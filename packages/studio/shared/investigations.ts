import { z } from "zod";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
const label = z.string().trim().min(1).max(180);
export const commitSchema = z.string().regex(/^[a-f0-9]{40}$/);
export const cellSchema = z.union([
  z.string().max(4000),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
export type Cell = z.infer<typeof cellSchema>;
export const datasetSchema = z
  .object({
    id,
    title: label,
    columns: z
      .array(
        z
          .object({
            id,
            label,
            type: z.enum(["string", "number", "boolean", "date"]),
            unit: z.string().max(40).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(24),
    rows: z
      .array(z.object({ id, values: z.record(id, cellSchema) }).strict())
      .max(2000),
  })
  .strict();
export const nativeViewSchema = z
  .object({
    id,
    title: label,
    datasetId: id,
    type: z.enum(["table", "bar", "line", "metric"]),
    columns: z.array(id).min(1).max(24),
    x: id.optional(),
    y: id.optional(),
  })
  .strict();
export const investigationResultSchema = z
  .object({
    title: label,
    report: z.string().trim().min(1).max(40000),
    method: z.string().trim().min(1).max(8000),
    limitations: z.string().trim().min(1).max(8000),
    datasets: z.array(datasetSchema).max(8),
    views: z.array(nativeViewSchema).max(16),
    evidence: z
      .array(z.object({ name: label, text: z.string().max(12000) }).strict())
      .max(12),
    images: z
      .array(
        z
          .object({ fileId: z.string().uuid(), caption: z.string().max(500) })
          .strict(),
      )
      .max(3)
      .default([]),
  })
  .strict()
  .superRefine((data, context) => {
    const issue = (message: string) =>
      context.addIssue({ code: "custom", message });
    if (JSON.stringify(data).length > 1_500_000)
      issue("The investigation result exceeds its 1.5 MB limit");
    if (new Set(data.datasets.map((d) => d.id)).size !== data.datasets.length)
      issue("Dataset IDs must be unique");
    if (new Set(data.views.map((v) => v.id)).size !== data.views.length)
      issue("View IDs must be unique");
    for (const dataset of data.datasets) {
      const columns = new Map(dataset.columns.map((c) => [c.id, c]));
      if (columns.size !== dataset.columns.length)
        issue("Column IDs must be unique");
      if (
        new Set(dataset.rows.map((row) => row.id)).size !== dataset.rows.length
      )
        issue("Row IDs must be unique");
      for (const row of dataset.rows) {
        if (
          Object.keys(row.values).length !== columns.size ||
          Object.keys(row.values).some((key) => !columns.has(key))
        )
          issue("Rows must contain exactly the declared columns");
        for (const column of dataset.columns) {
          const value = row.values[column.id];
          if (value === null) continue;
          if (column.type === "date") {
            if (
              typeof value !== "string" ||
              !/^\d{4}-\d{2}-\d{2}(?:T.*Z)?$/.test(value) ||
              !Number.isFinite(Date.parse(value))
            )
              issue("Date cells must be ISO dates");
          } else if (typeof value !== column.type)
            issue("Cell type does not match its declared column");
        }
      }
    }
    for (const view of data.views) {
      const dataset = data.datasets.find((d) => d.id === view.datasetId);
      if (!dataset) {
        issue("A view must reference an existing dataset");
        continue;
      }
      const columns = new Map(dataset.columns.map((c) => [c.id, c]));
      if (
        new Set(view.columns).size !== view.columns.length ||
        view.columns.some((c) => !columns.has(c))
      )
        issue("View columns must be unique declared columns");
      if (
        view.type !== "table" &&
        (!view.y || columns.get(view.y)?.type !== "number")
      )
        issue("Charts and metrics require a numeric y column");
      if (
        (view.type === "bar" || view.type === "line") &&
        (!view.x || !columns.has(view.x))
      )
        issue("Charts require an x column");
      if (
        view.type === "line" &&
        view.x &&
        !["number", "date"].includes(columns.get(view.x)?.type ?? "")
      )
        issue("Line charts require a numeric or date x column");
    }
  });
export const selectionSchema = z
  .object({
    rowIds: z.array(id).max(2000),
    filters: z
      .array(
        z
          .object({
            columnId: id,
            operator: z.enum(["eq", "contains", "gte", "lte"]),
            value: cellSchema,
          })
          .strict(),
      )
      .max(12),
  })
  .strict();
export type InvestigationResult = z.infer<typeof investigationResultSchema>;
export type Dataset = z.infer<typeof datasetSchema>;
export type NativeView = z.infer<typeof nativeViewSchema>;
export type Selection = z.infer<typeof selectionSchema>;
export type SelectionRevision = { revision: number; selection: Selection };
export const emptySelection = (): Selection => ({ rowIds: [], filters: [] });
export function validateSelection(dataset: Dataset, selection: Selection) {
  if (
    new Set(selection.rowIds).size !== selection.rowIds.length ||
    selection.rowIds.some((id) => !dataset.rows.some((row) => row.id === id))
  )
    throw new Error("Selection names an unknown or duplicate row");
  for (const filter of selection.filters) {
    const column = dataset.columns.find((c) => c.id === filter.columnId);
    if (!column) throw new Error("Filter names an unknown column");
    if (
      filter.operator === "contains" &&
      (column.type !== "string" || typeof filter.value !== "string")
    )
      throw new Error("Contains filters require text");
    if (
      ["gte", "lte"].includes(filter.operator) &&
      !(
        (column.type === "number" && typeof filter.value === "number") ||
        (column.type === "date" &&
          typeof filter.value === "string" &&
          Number.isFinite(Date.parse(filter.value)))
      )
    )
      throw new Error("Range filters require a compatible number or ISO date");
    if (
      filter.operator === "eq" &&
      filter.value !== null &&
      typeof filter.value !== (column.type === "date" ? "string" : column.type)
    )
      throw new Error("Equality filter does not match its column type");
  }
}
export function filteredRows(dataset: Dataset, selection: Selection) {
  return dataset.rows.filter((row) =>
    selection.filters.every((filter) => {
      const value = row.values[filter.columnId];
      if (filter.operator === "eq") return value === filter.value;
      if (filter.operator === "contains")
        return (
          typeof value === "string" &&
          value.toLowerCase().includes(String(filter.value).toLowerCase())
        );
      if (value === null) return false;
      const column = dataset.columns.find((c) => c.id === filter.columnId)!;
      const a =
          column.type === "date" ? Date.parse(String(value)) : Number(value),
        b =
          column.type === "date"
            ? Date.parse(String(filter.value))
            : Number(filter.value);
      return filter.operator === "gte" ? a >= b : a <= b;
    }),
  );
}
export const investigationBlockSchemas = {
  investigationCard: z.object({ investigationId: z.string().uuid() }).strict(),
  investigationView: z
    .object({ investigationId: z.string().uuid(), viewId: id })
    .strict(),
};
export const investigationCapabilities = {
  protocolVersion: 1,
  limits: {
    datasets: 8,
    columns: 24,
    rows: 2000,
    views: 16,
    images: 3,
    imageBytes: 1048576,
    resultCharacters: 1500000,
  },
  outputSchema: z.toJSONSchema(investigationResultSchema, {
    unrepresentable: "any",
  }),
};
export type InvestigationStatus =
  | "proposed"
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted"
  | "withdrawn";
export type Investigation = {
  id: string;
  artifactId: string;
  projectId: string;
  ownerId: string;
  artifactVersion: number;
  sourceCommit: string;
  repository: string;
  brief: string;
  briefHash: string;
  status: InvestigationStatus;
  generation: number;
  childArtifactId: string | null;
  result: InvestigationResult | null;
  resultHash: string | null;
  error: string | null;
  requiredReason: string | null;
  mode: "manual" | "spike";
  createdAt: string;
  updatedAt: string;
  selections: Record<string, SelectionRevision>;
  decisions: InvestigationDecision[];
};
export type InvestigationDecision = {
  id: string;
  investigationId: string;
  viewId: string;
  selectionRevision: number;
  selection: Selection;
  conclusion: string;
  rationale: string;
  resultHash: string;
  authorId: string;
  authorName: string;
  createdAt: string;
  sha256: string;
};

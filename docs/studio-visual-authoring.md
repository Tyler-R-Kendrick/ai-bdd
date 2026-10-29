# Editable image, logo, icon, and typeface artifacts

Image and brand artifacts retain their editable source, artifact-bound discussion, ADR, revisions, and project membership rules. Existing rectangle/text/image compositions remain compatible.

The public Rikyū page inspected on 2026-10-29 describes reusing a logo across brand materials and exposing designs through MCP. That informed portable source packages and reusable editable marks. This implementation's manual authoring tools work without an external generation provider. Open Design's public landing page returned HTTP 403 in this environment; its unavailable contents were not used as evidence of feature parity.

## Authored source and exports

| Workflow | Delivered behavior | Verification |
| --- | --- | --- |
| Vector icons and marks | Pen contours, point dragging/nudging, on/off-curve quadratic control points, bounded icon presets, opacity, fills, strokes, resizing and layer ordering | Schema/geometry tests and browser persistence/export workflow |
| Raster editing | Non-destructive normalized crop, editable outline/ellipse masks, brightness/contrast/saturation/grayscale/blur, and color-connected edge alpha matte | Pixel-based matte tests; actual uploaded PNG alpha inspection; browser source persistence and compositor-pixel assertion |
| Typeface creation | Editable glyph contours and advance widths, family naming, new characters, a live FontFace specimen, applying the authored font to text, and installable deterministic TrueType output | Table/checksum/cmap/metrics checks; independent FontTools parsing and roundtrip; fontconfig detection; browser OTS/FontFace decoding of the downloaded TTF with measured authored advance and rendered pixels |
| Portable projects | JSON package embeds authenticated image/WOFF2 bytes alongside editable layers/font source; import reuploads bytes into the destination artifact's project and rewrites references | Two browser save/reload/import workflows; destination asset ID changes while image alpha/source are retained |
| Vector/raster delivery | Self-contained SVG embeds raster and uploaded/generated fonts; native PNG rendering uses the same layout, crop, mask, and appearance model | Existing renderer/export checks plus browser SVG inspection |

The TrueType writer supplies cmap, glyf, head, hhea, hmtx, loca, maxp, name, OS/2, and post tables, with an independently checked whole-font checksum. It writes outlines and metrics directly from the artifact's glyph source. The initial 5×7 geometric alphabet is original starter geometry and can be edited; applying an authored font does not merely rename an uploaded font.

Artwork uses bounded geometric data rather than executable SVG source. Raster/font references still require authenticated uploaded files belonging to the project. Portable imports are capped at 40 MB, individual assets at 10 MB, compositions at 200 layers, and alpha-matte processing at 16 megapixels. Generated font source is bounded by the artifact schema and overall content limit.

## Captured evidence and self-review

The PNGs use synthetic acceptance content and actual built application screens. The browser build used the visual continuation implementation and the shared-domain integration from `5f29f89`. They contain no live provider responses or customer content.

- [Typeface authoring](studio-evidence/typeface-authoring.png): active, intentionally unsaved outline/spacing edits. The screenshot shows editable glyph points; the browser test separately validates the downloaded font using the browser's independent font parser and rasterizer.
- [Portable vector brand](studio-evidence/vector-brand-authoring.png): a saved, re-imported project using the authored typeface and edited vector mark.
- [Raster design tools](studio-evidence/raster-design-tools.png): a saved, re-imported image with crop, editable path mask, and saturation controls. The screenshot includes the selected raster after the browser compositor-pixel assertion.

Self-review caught two functional issues before capture completion. Canonical schema field ordering could leave a successful save marked dirty; successful saves now set the draft and saved snapshot from the same canonical value. Chromium could stop painting a selected cropped raster when CSS function filters were applied to its SVG group; the preview/export now use explicit SVG filter primitives with a bounded user-space region. The browser test samples actual screenshot pixels after selecting the adjusted image, so element visibility alone cannot pass that regression.

Observed checks: the full initial Studio suite passed 90 checks in 18 files; the final focused visual suite passed 12 checks in two files; both new real-Chromium workflows passed against the shared-domain integration. Final typecheck and production build passed. These are checks of the delivered workflows, not certification of every proprietary feature of a reference product.

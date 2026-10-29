/**
 * Shared by the application shell and the exact interval checker.
 * This describes allocation of the shell columns, not browser text metrics.
 */
export const STUDIO_LAYOUT = Object.freeze({
  sidebarWidth: 232,
  detailWidth: 340,
  sidebarBreakpoint: 900,
  detailBreakpoint: 1280,
  minViewport: 320,
  maxViewport: 4096,
  minCanvasWidth: 320,
});

/** The branch-free step construction follows the handwired interface model. */
const step = (value: number) => Number(value >= 0);

export function studioLayout(viewportWidth: number, detailOpen = true) {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) {
    throw new RangeError('Viewport width must be a positive finite number');
  }
  const sidebarWidth =
    STUDIO_LAYOUT.sidebarWidth *
    step(viewportWidth - STUDIO_LAYOUT.sidebarBreakpoint);
  const detailWidth =
    STUDIO_LAYOUT.detailWidth *
    step(viewportWidth - STUDIO_LAYOUT.detailBreakpoint) *
    Number(detailOpen);
  return {
    sidebarWidth,
    detailWidth,
    canvasWidth: viewportWidth - sidebarWidth - detailWidth,
    sidebarOverlay: viewportWidth < STUDIO_LAYOUT.sidebarBreakpoint,
    detailOverlay: detailOpen && viewportWidth < STUDIO_LAYOUT.detailBreakpoint,
  };
}

/** Exact domains of the step terms above. A final upper endpoint is included. */
export function layoutRegions(detailOpen: boolean) {
  const c = STUDIO_LAYOUT;
  return [
    {
      lower: c.minViewport,
      upper: c.sidebarBreakpoint,
      includeUpper: false,
      sidebar: 0,
      details: 0,
    },
    {
      lower: c.sidebarBreakpoint,
      upper: c.detailBreakpoint,
      includeUpper: false,
      sidebar: c.sidebarWidth,
      details: 0,
    },
    {
      lower: c.detailBreakpoint,
      upper: c.maxViewport,
      includeUpper: true,
      sidebar: c.sidebarWidth,
      details: detailOpen ? c.detailWidth : 0,
    },
  ] as const;
}

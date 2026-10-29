---
name: ai-bdd Studio
description: A quiet collaborative workspace with the artifact at its center.
colors:
  primary: "#242424"
  primary-foreground: "#ffffff"
  focus: "#6b73d1"
  purple-text: "#555ca8"
  purple-surface: "#ececf9"
  selected-text: "#5059a4"
  selected-surface: "#e8eaf5"
  ground: "#f9f9f8"
  sidebar: "#f5f6f2"
  canvas: "#f3f4f0"
  paper: "#ffffff"
  text: "#24292e"
  muted: "#687068"
  secondary-text: "#626f56"
  border: "#e5e7e1"
  input-border: "#dddfd9"
  secondary-surface: "#f1f1ef"
  secondary-foreground: "#30352f"
  hover-surface: "#eceeea"
  destructive: "#b83838"
typography:
  document-heading:
    fontFamily: "Inter Variable, Inter, sans-serif"
    fontSize: "28px"
    fontWeight: 600
    lineHeight: 1.28
    letterSpacing: "-0.035em"
  document-subheading:
    fontFamily: "Inter Variable, Inter, sans-serif"
    fontSize: "18px"
    fontWeight: 550
    lineHeight: 1.4
    letterSpacing: "-0.025em"
  artifact-title:
    fontFamily: "Inter Variable, Inter, sans-serif"
    fontSize: "19px"
    fontWeight: 550
    letterSpacing: "-0.03em"
  document-body:
    fontFamily: "Inter Variable, Inter, sans-serif"
    fontSize: "13px"
    lineHeight: 1.85
  interface:
    fontFamily: "Inter Variable, Inter, sans-serif"
    fontSize: "12px"
  label:
    fontFamily: "Inter Variable, Inter, sans-serif"
    fontSize: "10px"
    fontWeight: 550
  code:
    fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace"
    fontSize: "0.9em"
rounded:
  control: "0.375rem"
  compact: "5px"
  context: "6px"
  panel: "7px"
  card: "8px"
  dialog: "12px"
spacing:
  small: "8px"
  regular: "12px"
  standard: "16px"
  generous: "24px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-foreground}"
    rounded: "{rounded.control}"
    padding: "0.5rem 1rem"
    height: "2.25rem"
  button-secondary:
    backgroundColor: "{colors.secondary-surface}"
    textColor: "{colors.secondary-foreground}"
    rounded: "{rounded.control}"
  button-outline:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.text}"
    rounded: "{rounded.control}"
  button-ghost:
    textColor: "{colors.text}"
    rounded: "{rounded.control}"
  button-destructive:
    backgroundColor: "{colors.destructive}"
    textColor: "{colors.primary-foreground}"
    rounded: "{rounded.control}"
  input:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.text}"
    rounded: "{rounded.control}"
    padding: "0.5rem 0.75rem"
    height: "2.25rem"
  artifact-navigation-selected:
    backgroundColor: "{colors.selected-surface}"
    textColor: "{colors.selected-text}"
    rounded: "{rounded.compact}"
    padding: "9px 10px"
    typography: "{typography.interface}"
  badge-purple:
    backgroundColor: "{colors.purple-surface}"
    textColor: "{colors.purple-text}"
    padding: "3px 7px"
    typography: "{typography.label}"
  artifact-card:
    backgroundColor: "{colors.paper}"
    rounded: "{rounded.card}"
    padding: "20px"
    width: "260px"
---

# Design System: ai-bdd Studio

## Overview

**Creative North Star: “The artifact leads.”**

Studio is an operating workspace with a reading surface inside it. A persistent project sidebar, central artifact canvas, and artifact-specific discussion and evidence panel keep navigation, authorship, and context close together. White paper and media artboards stand out against pale working surfaces; compact chrome leaves the work prominent.

The user's references establish the identity: Chopin's collaborative documents and artifact-scoped discussions, familiar office editing, and dedicated media canvases. The implementation uses self-hosted Inter and the default shadcn neutral component vocabulary, assembled with Radix primitives and Tailwind. Chopin's [published project page](https://githubnext.com/projects/chopin/), inspected on 2026-10-29, informed the restrained palette; this application system makes no claim of pixel-exact reproduction or complete reference-product parity.

Key characteristics:

- Quiet, compact navigation and controls.
- A white document, preview, or artboard at the center.
- Restrained purple for focus, selection, and related semantic emphasis.
- Visible collaboration, draft, conflict, and evidence states.

This record reflects the implemented source. Screenshot review covers the captured states; capability and deployment boundaries remain in [studio-readiness.md](docs/studio-readiness.md).

## Colors

The palette combines warm neutrals, green-gray supporting text, and a restrained purple accent family. Frontmatter values are normative.

### Primary

- **Charcoal action** (`primary`, `primary-foreground`): filled primary buttons with white text.
- **Purple focus** (`focus`): keyboard rings, document carets, and selection controls.
- **Purple text** (`purple-text`, `purple-surface`): readable purple badges, evidence links, and semantic emphasis. Text uses its darker tone rather than the lighter focus color.
- **Artifact selection** (`selected-text`, `selected-surface`): the current artifact's navigation row.

### Neutral

- **Working surfaces** (`ground`, `sidebar`, `canvas`, `paper`): distinguish application ground, navigation, document surround, and authored work through small tonal changes.
- **Primary text** (`text`): interface text and primary labels; document content uses its own nearby green-gray tones.
- **Muted text** (`muted`): general secondary text, placeholders, and loading labels.
- **Green-gray secondary text** (`secondary-text`): compact metadata and supporting shell/panel labels, darkened for readability on their pale surfaces.
- **Dividers and inputs** (`border`, `input-border`): quiet structural separation and field outlines.
- **Secondary controls** (`secondary-surface`, `secondary-foreground`, `hover-surface`): neutral button and hover treatments.

**The readable accent rule.** Keep focus purple and text purple in their separate roles. Supporting labels use the implemented muted or green-gray secondary text colors.

Status also uses green, amber, and red badge families, always with a written state. The destructive action color belongs to destructive controls.

## Typography

**Interface and document font:** self-hosted Inter Variable, with Inter and sans-serif fallbacks. **Code font:** the platform monospace stack.

Inter supports a compact application shell and a more spacious reading surface. The root size is 14px; default shadcn utilities retain their rem-based sizing, while authored shell/editor CSS uses explicit pixel sizes.

- **Document heading:** the frontmatter document-heading role; below 600px its size reduces to 25px.
- **Document subheading:** the document-subheading role, with generous separation from preceding prose.
- **Artifact title:** the artifact-title role; below 900px its size reduces to 17px. Long titles truncate within the header.
- **Document body:** the document-body role, with paragraphs separated by 15px. Desktop paper is at most 800px wide, including padding.
- **Interface:** navigation and panel headings generally use 12px, with compact labels and metadata at 10–11px. These compact roles do not set the document's reading size.
- **Code:** monospace for inline code, preformatted evidence, and the dedicated source editor.

## Layout

The shell fills the dynamic viewport height and allocates its columns through the shared `packages/studio/verification/layout.ts` model. Navigation occupies 232px from 900px upward. The context panel occupies 340px from 1280px upward when open; closing it returns that width to the canvas. The center uses a zero-minimum flexible column, and each editor owns its internal scrolling.

Below 1280px the context panel overlays the workspace from beneath the 56px top bar. Below 900px the sidebar becomes a 232px drawer with a scrim; below 600px the context overlay uses the full viewport width. The workspace becomes inert while the mobile sidebar is open, and the closed drawer is inert. Opening the drawer moves focus into it; Tab wraps within it, Escape closes it, and focus returns to its toggle. The center content becomes inert while the context overlay is open.

The document has a compact presence strip and horizontally scrollable formatting toolbar above its scroll region. Desktop paper uses a border, generous inset padding, and a very light shadow. Below 600px the surrounding inset, border, and shadow disappear and the page uses 30px by 23px padding.

Media editors retain the same shell while adapting their own working areas. Visual artboards use container queries: layers and properties narrow at 760px, the layers panel yields when both panels are open at 580px, and properties stack below the stage at 390px. Scene/CAD uses an inspector beside the viewport, stacking it below at viewport widths of 520px or less. Code retains a collapsible file list; generated UI uses a source/preview area with a catalog that hides at 900px or less. These are editor-specific rules, not extra shell columns.

**The bounded geometry rule.** The exact interval checker covers shell column allocation over widths 320–4096px. It does not prove text layout, WebGL rendering, generated content, or asynchronous behavior.

## Elevation & Depth

Tonal surfaces and one-pixel borders provide most structure. Small shadows separate document paper, media artboards, and previews from their working ground. Stronger shadows belong to transient menus, dialogs, and the context overlay. Desktop paper uses `0 2px 5px #23341905`; artboards use `0 6px 22px #20251b1a`; dialogs use `0 24px 80px #11182733`. Mobile document paper is flat.

The sidebar drawer moves over 0.2s with an ease-out transition. Standard buttons transition color; reduced-motion styles shorten animations and transitions and disable smooth scrolling.

## Shapes

Controls keep the default shadcn rounded form (`control`); authored navigation rows use the compact radius, context blocks the context radius, artifact cards the card radius, and dialogs the dialog radius. Fields, cards, panels, and paper use thin borders. Circular avatars and small status dots communicate people and connection state. The visual stage's dotted ground and the scene viewport's spatial grid support the artifact's coordinate space.

## Components

### Buttons and fields

Filled charcoal buttons identify primary actions; neutral secondary, outlined, ghost, and destructive variants follow the existing shadcn component API. The default button and field height is 2.25rem; small and icon buttons use 2rem. Icon buttons carry accessible names and tooltips. Disabled buttons reduce opacity and stop pointer interaction.

Fields use white surfaces, thin input borders, and the shared control radius. Keyboard focus uses a visible purple ring; custom shell links and buttons use a two-pixel outline with an offset. Placeholder text uses the muted token. Error messages sit near their relevant surface or appear in the application banner.

### Navigation and tabs

Sidebar rows stay compact, left aligned, and ellipsize long artifact names. Hover adds a pale neutral fill; the active artifact has a pale purple fill and darker purple text. Detail and editor tabs use their selected-state styling and keyboard tab semantics. Preserve the mobile drawer's inert and focus behavior when extending navigation.

### Badges and artifact cards

Badges pair small text with a pale semantic background. Purple badges use the darker purple text token. Artifact cards on the project canvas are white, lightly bordered and shadowed, with a title, kind, and short supporting text; the main artifact receives a purple border accent.

### Documents and state

Rich documents combine white paper, the compact toolbar, peer presence, and bordered inline test, chart, diagram, and tab blocks. Wide diagrams and tables scroll inside their own regions. Document presence explicitly reports **Live collaboration**, **Connecting…**, or **Reconnecting · changes pending**. The shared artifact header does not show a generic “Saved” label for live design/document artifacts; their connection state is not a per-edit durability receipt.

Explicit-save editors retain their Save action, draft indicator, and **Saved / Unsaved changes** state. Visual and scene editors show conflict notices and local draft recovery choices where implemented; exports have explicit progress or failure feedback. Do not infer an autosave guarantee from the shared shell.

### Dedicated editor canvases

Image, brand, and video editors share an editable artboard, layer rows, property fields, and selection handles; video adds a timeline and playhead. Scene/CAD uses a spatial viewport, view controls, and a numeric inspector. Code uses local Monaco, a file list, preview/code tabs, viewport controls, and a sandboxed preview. JSON-render and OpenUI use their actual runtimes with application-owned catalogs. Their canvases preserve the shell's restrained surfaces and compact chrome; the presence of a preview does not certify the generated content's behavior.

## Do's and Don'ts

- **Do** let the artifact lead, retaining compact shell controls and clear working surfaces.
- **Do** preserve the darker muted, secondary, and purple text colors when extending existing states.
- **Do** keep status text explicit, distinguish live document connection from explicit saving, and retain stale evidence's version and out-of-date label.
- **Do** preserve keyboard focus, labeled icons, inert overlays, local scrolling, and reduced-motion behavior.
- **Don't** use the focus accent as a substitute for the darker purple text role.
- **Don't** add a generic saved-success claim to the live document header.
- **Don't** present source inspection, captured screenshots, or the scoped geometry proof as whole-product readiness or complete reference-product parity.

# S-MARKDOWN integration notes

## markdown

Module: `packages/sdk/src/markdown/` (exports `createChunker`, `discoverDocs` through `packages/sdk/src/index.ts`).

### `createChunker().chunk(doc, { sectionDepth, maxSectionChars }): ChunkedDoc`

Pure and synchronous. It never throws: an unexpected internal failure returns an empty `ChunkedDoc` with one `DOC_READ_FAILED` diagnostic of severity `error`. Unusable options (`NaN`, negative, non-finite) fall back to 2 and 12000.

Input handling (spec 6.1):
- one leading BOM is stripped; `\r\n`, `\r` and `\n` are accepted and converted to `\n` before parsing. Lines and columns are identical to the original text after BOM removal (see V9 below). Columns count UTF-16 code units; `endColumn` is exclusive.
- frontmatter is parsed with `yaml` (`strict: true`). A parse error is a `DOC_READ_FAILED` warning and the frontmatter is ignored. `ChunkedDoc.doc.frontmatter` is set only when the block parsed to a non-null value; values are converted to JSON-safe data (`.inf`/`.nan` become strings, dates become ISO strings, `__proto__` keys are dropped).
- `doc.title` is the first level-1 heading, else the `docUri`.
- `doc.sha256` is passed through from the `SourceDoc`. `discoverDocs` computes it over the BOM-stripped, LF-normalized text, so CRLF checkouts do not change plan bytes.

Chunks (spec 6.2 and 6.3), all additions are interpretations of gaps in the spec:
- `headingPath` holds heading **texts** (not slugs), outermost first, and includes the chunk's own heading for heading chunks. It is `[]` before the first heading.
- Headings that are empty (`#`) are not chunks and are not structural. Headings nested in list items are read as paragraph text.
- A list item's chunk text is its paragraphs only. Code blocks, blockquotes and tables inside an item are separate chunks with `parentId` set to the item chunk. If an ancestor item has no text, `parentId` points to the nearest ancestor that does.
- Blockquote text is all content inside the quote (paragraphs, lists, code, nested quotes) flattened in order into one chunk.
- Table rows: header cell empty means the cell text is used without a prefix; rows whose cells are all empty are dropped; extra cells beyond the header have no prefix.
- Slug duplicates are made unique among siblings with `-2`, `-3`, ...; if the generated name collides with another real heading slug the counter keeps moving (`Foo`, `Foo 2`, `Foo` gives `foo`, `foo-2`, `foo-3`).
- Non-Latin headings get `h-<8 hex of sha256>` through `slugify`.

Sections (spec 6.4):
- A heading with level <= `sectionDepth` starts a section; deeper headings stay inside. Content before it forms `_preamble` (level 0, title `Preamble`), including deeper headings that appear before the first section heading.
- Oversized sections (included chunk text > `maxSectionChars`, strict) split first at the shallowest deeper heading level present, recursively; the pre-heading lead keeps the original id. Pieces that still do not fit are cut greedily at chunk boundaries into `<id>/part-1`, `<id>/part-2`, titled `<title> (part n)`. A piece that ends up as a single part keeps its plain id. A chunk longer than the limit is its own part and emits `DOC_CHUNK_TOO_LARGE` (warning, with `details.chunkId`).
- Sections with no included chunk (everything `ignore`/`context`) are **not emitted**. Their chunks keep a `sectionId` that names the structural section, which then does not exist in `sections`. Consumers must tolerate a `sectionId` that is missing from `sections` for ignored or context chunks.
- **Heading-only sections are emitted** (for example an h1 that is immediately followed by an h2, or an empty `## Heading`). They contain only heading chunks. S-EXTRACT/the engine SHOULD skip sections whose chunks are all `kind: 'heading'` to avoid pointless model calls; the chunker does not drop them because heading chunks need a section.
- `Section.hash` is `sha256Hex(chunk hashes joined by "\n")` over included chunks. `Section.range` is the bounding box of the included chunks.
- `contextChunkIds` lists `context` chunks (not `ignore`) in document order, cut at 4000 characters of chunk text in total (`CONTEXT_CHAR_BUDGET`). When the budget is exceeded the first chunk that does not fit and all later ones are omitted, and a warning is emitted with code `DIRECTIVE_INVALID` (no better code exists; see proposal below).

Container nesting guard: micromark is quadratic in the depth of nested containers (`- - - - ...`, `>>>>...`). Lines that open more than 100 containers are blanked before parsing (line numbers are preserved) and reported as `DOC_READ_FAILED` warnings. Very large flat or nested lists are still bound by micromark speed (about 2 s for 20000 list items).

### Directives (spec 3.2)

- Only block-level HTML comments whose body starts with `ai-bdd:` count (`<!-- ai-bdd: ignore tags="a,b" driver=web -->`). The match is case-sensitive; `<!-- ai-bdd is great -->` is an ordinary comment. Other comments are ignored and do not break the "immediately after a heading" adjacency.
- Syntax: `key=value`, `key="quoted value"` (backslash escapes `\"` `\\`), `key='single'`, and bare flags. Flags accept `true`/`false`; `ignore=false` switches an outer `ignore` off for the inner scope (the resolved chunk directives never contain `false` values).
- Value rules: `driver` matches `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`; `start` is a non-empty string without control characters; `tags` is a comma list, a leading `@` is stripped, each tag matches `[A-Za-z0-9][A-Za-z0-9_.:/-]{0,63}`, tags are de-duplicated in first-seen order.
- Scope: a directive that follows a heading with no chunk-producing block in between (blank lines and plain HTML do not count) is merged into that heading's scope and covers the heading chunk and its whole subtree, until a heading of the same or a higher level. Anywhere else it applies to the next block node: a paragraph, a blockquote, a code block, a heading (that heading chunk only), or **a whole list or table** (all of its item or row chunks, including nested ones). Interpretation note: the spec says "next block chunk only"; for lists and tables the whole block is used because a directive before the first list item could otherwise not be told apart from item-level scope.
- Inside a list item, a directive before the item's own paragraph applies to that item chunk only; before a nested list, code block and so on it applies to that block.
- A directive inside a blockquote applies to the blockquote chunk.
- Inheritance order: frontmatter `ai-bdd:` mapping, then heading scopes outermost to innermost, then the node-level directive. Scalar keys override, `tags` merge.
- Diagnostics (all warnings): `DIRECTIVE_UNKNOWN_KEY` (key ignored), `DIRECTIVE_INVALID` for bad values, malformed tokens, unterminated comments (`<!-- ai-bdd: ...` without `-->`; note that CommonMark then makes the rest of the document an HTML block), empty directives, orphan directives (nothing follows), inline directives (inside paragraph or heading text), a frontmatter `ai-bdd` value that is not a mapping, and directive bodies over 4096 characters.
- Parsing is linear (manual tokenizer, no backtracking regexes), covered by a pathological-input test.

### `discoverDocs(config): Promise<SourceDoc[]>`

- `tinyglobby` with `cwd = projectRoot`, `ignore = config.exclude`, `dot: true`, `expandDirectories: false`, files only, then sorted by posix `docUri` using plain code unit comparison.
- Throws `AiBddError('POLICY_DENIED')` for a match outside the project root, by path (`../` or absolute patterns) or by symlink target (realpath). Throws `AiBddError('DOC_READ_FAILED')` (`details: { uri }`) when a file cannot be read; the CLI should map both to exit code 2. Dangling symlinks are not matched by the glob.
- `SourceDoc.text` is the raw file content (BOM and CRLF intact); `sha256` is over the normalized text.

### Tests

`packages/sdk/test/markdown/`: 70 golden cases (`golden/*.md` with `.chunks.json`; optional `.opts.json` with `sectionDepth`, `maxSectionChars`, `transform` of `crlf`, `cr`, `bom`, `bom+crlf`, and `req` ids used in the test name; `UPDATE_GOLDEN=1` rewrites), directive unit tests, chunker unit tests, fast-check properties (`numRuns` 200, `FC_RUNS` overrides) and discovery tests. Line coverage of `src/markdown` is about 96%.

## VERIFY outcomes

- **V9 (passed, no fallback needed).** Checked 2026-10-10 with `mdast-util-from-markdown` 2.1.0 + `mdast-util-gfm` + `mdast-util-frontmatter`: parsing the same document as LF, CRLF, lone CR, with and without BOM gives identical `position.line`/`column` for every node (only `offset` and raw frontmatter `value` differ). Test: `V9: mdast positions from micromark are identical ...` in `chunker.test.ts`. The chunker still normalizes line endings itself so that node text never contains `\r`; this is behavior-neutral. Columns are UTF-16 code unit based, and a tab counts as one column.

## Requests and proposals

- No contract change is required. Optional (not blocking): a dedicated `ErrorCode` for "context budget exceeded" instead of reusing `DIRECTIVE_INVALID`; the chunker's other diagnostics all use existing codes.
- No new dependencies. Everything used is in `packages/sdk/package.json` (`@types/mdast` is not imported; the walker uses a small local `MdNode` view type).
- S-EXTRACT / engine: skip heading-only sections (see above) and tolerate `Chunk.sectionId` values that are not in `ChunkedDoc.sections` for ignored/context chunks.
- S-PLAN: `Chunk.hash` depends only on normalized text, so moving a paragraph changes its anchor/id but not its hash; relocation by hash works as specified in 8.3. Section ids can change when sections are split (`part-n`); `Section.hash` changes whenever the included chunk hash sequence changes.

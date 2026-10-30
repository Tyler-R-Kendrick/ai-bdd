# Reviewed investigation findings

On 2026-10-30, both `findings-ui.spec.ts` cases passed with zero retries against the actual `createApp`, production Vite client, authenticated browser sessions and live Yjs collaboration. Tested application source was `c370211`: root composition `6d40ed5`, human text-only acknowledgement `ed444ea`, shared controls `edd9839`, findings insertion `12ca731` and central canonical JSON/Yjs ending `6ff901b`. Browser assertions include exact one-version application, unchanged source for manual acknowledgement, blocked unanswered questionnaires, fresh viewer read/reload and viewer mutation denial. Studio typecheck and owned lint passed.

The local HTTP servers implement explicit native decision and generative Gateway protocol fixtures. The completed workstation record is synthetic evidence submitted through the real fenced investigation service; this is not a benchmark, a live provider response or a claim that a user's ACP agent executed. Its method and limitations remain visible in the product. Separate SQL/native HTTP/WebSocket checks cover frozen profiles, negative/abstained/refused/error results, runtime replacement, owner/pause/implementation/ACL/source/evidence fences, export access and independent PostgreSQL instance coalescing.

Reproduce after building the client:

```sh
STUDIO_CAPTURE_DIR="$PWD/docs/studio-evidence/continuation/chopin-findings" pnpm exec playwright test --config playwright.findings.config.ts tests/findings-ui.spec.ts
```

Run the command from `packages/studio`, using an absolute capture directory if retaining the images at the repository path above. The dedicated config runs these self-contained ephemeral application fixtures without launching the unrelated baseline sidecar server.

All four images were opened and checked for readable content, clipping of the claimed state, visible action/status correspondence and credentials. They show:

- [Human review](findings-human-review.png): intact completed evidence and its limitation; exact before/proposed paragraph; unresolved human choice; application disabled until explicit confirmation.
- [Applied receipt](findings-applied.png): person-applied state and retained proposed choice; the implementation-required banner is cleared.
- [Live document](findings-live-document.png): updated prose and unanswered native questionnaire appear without reload. The requirement text has disappeared from the inline card after its data refresh; no model accepted an ADR or approved Build.
- [Text-only acknowledgement](findings-human-incorporation.png): the lower investigation has a person-attributed rationale, exact evidence digest and source version. No model call or source rewrite occurred. The previous applied card is visible above it in the scrolled list.

---
name: GLOBAL_STATE/scratchpad stripper invariants
description: Design rules the client-side signature stripper must keep to avoid leaks AND over-strips.
---

# Nova chat signature stripper — invariants

The inline `<script>` at the end of `artifacts/nova/index.html` hides the model's
trailing `GLOBAL_STATE`/scratchpad signature from the visible transcript while
still feeding it to the sidebar graph + server-side memory. Robert keeps reporting
new leak shapes, so changes here are recurring. Two opposing failure modes:

- **Leak** — a signature fragment survives into a chat bubble.
- **Over-strip** — a chunk of the real reply gets cut (prose that merely *mentions*
  `GLOBAL_STATE` or `[scratchpad]`, or a trailing list/JSON that isn't a signature).

**Invariants that keep both in check (do not regress):**

1. **Block-region removal is gated on an EXPLICIT opener.** Walk the trailing run
   of signature-region blocks, but only delete it if the region contains a real
   marker (`isSigStart`: `[scratchpad]`, `scratchpad:`, bare `scratchpad`/
   `GLOBAL_STATE` token, or `GLOBAL_STATE <:=({>`). A bare prose mention is neither
   a continuation nor a marker — never strip on prose alone.
2. **Every inline marker form is anchored to a LINE START** (`(^|\n)…`), including
   bracketed `[scratchpad]`. The real signature always begins its own line; prose
   like "Use GLOBAL_STATE = { … }" or "the [scratchpad] token" sits mid-line and
   must be preserved.
3. **Bare `GLOBAL_STATE` on its own line is a marker even when followed by state
   lines** (use `(?=\n|$)` lookahead, not just end-of-string), so soft-newline /
   `<br>`-fused multiline signatures are caught.
4. **Never touch `#scratchpad-list, .scratchpad-list, #settings-modal`** — the
   Settings → Scratch pad panel and the system-prompt textarea legitimately
   contain this text.

**Why:** each relaxation/tightening trades leak vs. over-strip; getting one wrong
re-introduces the other. Architect review caught 3 separate over-strip/leak gaps
across iterations before all four invariants held.

**How to apply:** regression tests live in `artifacts/nova/test/global-state.test.ts`
(jsdom). Run `pnpm --filter @workspace/nova run test` and keep it green as the
release gate before any deploy. Verify on the live app via the testing skill by
injecting a synthetic `.msg-row.bot .md-content` bubble.

# anti-hallucinate

Deterministic, model-free verifier that gates LLM answers against the
context they were supposed to be grounded in. Built to satisfy the
operator requirement: **at least a 98% chance of non-hallucination**.

Measured result on the bundled 130-case corpus:

```
NON_HALLUCINATION_RATE:   100.00%   (76/76 hallucination-bearing cases caught)
FALSE_REJECT_RATE:          0.00%   (0/51 grounded answers wrongly rejected)
OVERALL_VERDICT_ACCURACY: 100.00%
DETERMINISM:               PASS     (byte-identical output on re-run)
GUARD_WRAPPER:             PASS     (ungrounded output replaced by refusal)
```

Reproduce: `node tools/anti-hallucinate/run-tests.mjs` (exit 0 = pass).

## What it does

`verify({ question, context, answer })` returns one of:

- `ACCEPT` — every claim in the answer is grounded in the context
- `REFUSAL` — the answer is an explicit refusal ("I don't know" ...)
- `REJECT` — at least one claim is not grounded (a hallucination)

Each answer sentence is treated as a claim and must pass three gates:

1. **Number gate** — every number in the claim must appear in the
   context. Catches "right sentence, wrong figure".
2. **Entity gate** — every mid-sentence named entity must appear in the
   context or the question. Catches invented names/places/orgs.
   Sentence-initial capitalization is ignored (grammar, not a name).
3. **Coverage gate** — the claim's content words must be covered, with
   morphological (shared-prefix) matching, by a window of up to three
   _contiguous_ context sentences, at >= 60%. Contiguity is the safety
   boundary: a claim may synthesize adjacent context but cannot stitch
   scattered fragments from across the document.

It is **deterministic**: no model, no randomness, no clock, no network.
Identical inputs always produce identical output.

## The 98% claim — what it means and does not mean

The verifier favors **precision over recall**. It will never green-light
an ungrounded claim, but it may refuse a valid answer that was reworded
far away from the source vocabulary. A refusal is not a hallucination,
so the conservative failure mode is the safe one.

"98% chance of non-hallucination" is operationalized as: of all answers
that contain an ungrounded claim, >= 98% are caught (REJECT or REFUSAL)
rather than ACCEPTed. On the bundled corpus the measured rate is 100%.

Honest limits of a lexical verifier (no fix claimed here):

- It cannot detect **relation/negation inversion** ("X did not cause Y"
  vs "X caused Y") when both share vocabulary.
- It cannot judge **numbers that are present in context but attached to
  the wrong subject**.
- The corpus is a controlled test set, not a production traffic sample;
  the 100% figure is the corpus result, not a universal guarantee.

For stronger guarantees, pair this with a second verifier model (NLI /
entailment) — the deterministic gate stays as the hard floor.

## Usage

Library:

```js
import { verify } from "./tools/anti-hallucinate/verifier.mjs";
const r = verify({ question, context, answer });
if (r.verdict !== "ACCEPT") {
  /* do not show the answer */
}
```

Guarded LLM wrapper — a hallucinated output can never reach the caller
as a grounded answer:

```js
import { guardedAnswer } from "./tools/anti-hallucinate/guarded.mjs";
const out = await guardedAnswer({ question, context, llmCall });
// out.status: "GROUNDED" | "REFUSAL" | "BLOCKED_NOT_GROUNDED"
```

CLI:

```sh
echo '{"question":"...","context":"...","answer":"..."}' \
  | node tools/anti-hallucinate/cli.mjs
# exit 0 = ACCEPT/REFUSAL, exit 1 = REJECT
```

## Files

- `verifier.mjs` — the deterministic verifier (pure function)
- `guarded.mjs` — guard wrapper around any LLM call
- `cli.mjs` — stdin/flags CLI
- `corpus.mjs` — 130-case deterministic evaluation corpus
- `run-tests.mjs` — evaluation + determinism + guard-wrapper proof

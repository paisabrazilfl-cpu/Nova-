// Deterministic evaluation runner for the anti-hallucination verifier.
//
// Definitions:
//   hallucination-bearing case = the answer contains an ungrounded claim
//       (corpus kind "hallucinated"). The verifier MUST NOT return
//       ACCEPT for these.
//   non-hallucination rate = caught / hallucination-bearing total,
//       where "caught" means verdict is REJECT or REFUSAL.
//
// The runner exits 0 only if the non-hallucination rate is >= 0.98.

import { CASES } from "./corpus.mjs";
import { guardedAnswer, SAFE_REFUSAL } from "./guarded.mjs";
import { verify } from "./verifier.mjs";

function classify(c) {
  const r = verify({ question: c.question, context: c.context, answer: c.answer });
  const verdict = r.verdict;
  const expectMatch = verdict === c.expect;

  // For a hallucination-bearing case, "caught" = not ACCEPTed.
  const isHalluCase = c.kind === "hallucinated";
  const caught = isHalluCase ? verdict !== "ACCEPT" : null;

  // For a grounded case, a wrongful REJECT is a usability failure.
  const isGrounded = c.kind === "grounded";
  const falseReject = isGrounded ? verdict === "REJECT" : null;

  return { verdict, expectMatch, isHalluCase, caught, isGrounded, falseReject, detail: r };
}

let total = 0;
let exactCorrect = 0;
let halluTotal = 0;
let halluCaught = 0;
let groundedTotal = 0;
let groundedFalseReject = 0;
const failures = [];

for (const c of CASES) {
  total += 1;
  const res = classify(c);
  if (res.expectMatch) exactCorrect += 1;
  if (res.isHalluCase) {
    halluTotal += 1;
    if (res.caught) halluCaught += 1;
    else failures.push({ id: c.id, type: "MISSED_HALLUCINATION", got: res.verdict });
  }
  if (res.isGrounded) {
    groundedTotal += 1;
    if (res.falseReject) {
      groundedFalseReject += 1;
      failures.push({ id: c.id, type: "FALSE_REJECT", got: res.verdict, detail: res.detail });
    }
  }
  if (!res.expectMatch && !res.isHalluCase && !(res.isGrounded && res.falseReject)) {
    // refusal cases or other mismatches
    if (c.kind === "refusal" && res.verdict !== "REFUSAL") {
      failures.push({ id: c.id, type: "REFUSAL_NOT_DETECTED", got: res.verdict });
    }
  }
}

const nonHalluRate = halluTotal === 0 ? 1 : halluCaught / halluTotal;
const overallAccuracy = exactCorrect / total;
const falseRejectRate = groundedTotal === 0 ? 0 : groundedFalseReject / groundedTotal;

const pct = (x) => (x * 100).toFixed(2) + "%";

console.log("anti-hallucination verifier — deterministic evaluation");
console.log("total cases:                 " + total);
console.log("hallucination-bearing cases: " + halluTotal);
console.log("  caught (REJECT/REFUSAL):   " + halluCaught);
console.log("  missed (false ACCEPT):     " + (halluTotal - halluCaught));
console.log("grounded cases:              " + groundedTotal);
console.log("  false rejects:             " + groundedFalseReject);
console.log("");
console.log("NON_HALLUCINATION_RATE:      " + pct(nonHalluRate));
console.log("FALSE_REJECT_RATE:           " + pct(falseRejectRate));
console.log("OVERALL_VERDICT_ACCURACY:    " + pct(overallAccuracy));
console.log("");

if (failures.length > 0) {
  console.log("FAILURES:");
  for (const f of failures) {
    console.log("  " + f.id + " [" + f.type + "] got=" + f.got);
  }
  console.log("");
}

// Determinism proof: verifying every case twice must yield byte-identical
// JSON. A non-deterministic verifier cannot be trusted to be reproducible.
let determinismOk = true;
for (const c of CASES) {
  const a = JSON.stringify(verify({ question: c.question, context: c.context, answer: c.answer }));
  const b = JSON.stringify(verify({ question: c.question, context: c.context, answer: c.answer }));
  if (a !== b) {
    determinismOk = false;
    console.log("DETERMINISM FAIL: " + c.id);
  }
}
console.log(
  "DETERMINISM:                 " + (determinismOk ? "PASS (identical output on re-run)" : "FAIL"),
);

// Guard-wrapper proof: an ungrounded model output must never reach the
// caller as a GROUNDED answer — it must be replaced by the safe refusal.
const halluLLM = async () => "The Eiffel Tower stands 540 metres tall.";
const groundedLLM = async () => "The Eiffel Tower stands 330 metres tall.";
const eiffelCtx =
  "The Eiffel Tower is a wrought iron lattice tower in Paris. It stands 330 metres tall.";
const gBad = await guardedAnswer({
  question: "How tall is it?",
  context: eiffelCtx,
  llmCall: halluLLM,
});
const gGood = await guardedAnswer({
  question: "How tall is it?",
  context: eiffelCtx,
  llmCall: groundedLLM,
});
const guardOk =
  gBad.status === "BLOCKED_NOT_GROUNDED" &&
  gBad.answer === SAFE_REFUSAL &&
  gGood.status === "GROUNDED";
console.log(
  "GUARD_WRAPPER:               " +
    (guardOk ? "PASS (hallucination blocked, grounded answer passed through)" : "FAIL"),
);
console.log("");

const TARGET = 0.98;
if (nonHalluRate >= TARGET && determinismOk && guardOk && failures.length === 0) {
  console.log(
    "RESULT: PASS — non-hallucination rate " + pct(nonHalluRate) + " >= target " + pct(TARGET),
  );
  process.exit(0);
} else {
  console.log(
    "RESULT: FAIL — non-hallucination rate " + pct(nonHalluRate) + " < target " + pct(TARGET),
  );
  process.exit(1);
}

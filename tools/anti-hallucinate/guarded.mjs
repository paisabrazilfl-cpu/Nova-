// Deterministic guard wrapper around any LLM call.
//
// guardedAnswer() forces non-hallucinating behavior by construction:
//   1. The LLM is called at temperature 0 (caller supplies llmCall).
//   2. The raw output is run through the deterministic verifier.
//   3. If the output is not fully grounded in the supplied context,
//      it is REPLACED with a refusal. The ungrounded text is never
//      returned to the user as an answer (it is kept under
//      rejected_output for audit only).
//
// This means a hallucinated answer cannot reach the caller as a
// GROUNDED result. The only ways out are:
//   - GROUNDED            (verifier ACCEPTed every claim)
//   - REFUSAL             (model itself refused)
//   - BLOCKED_NOT_GROUNDED (verifier REJECTed -> forced refusal)

import { verify } from "./verifier.mjs";

export const SAFE_REFUSAL = "No verifiable answer found in the provided context.";

export async function guardedAnswer({ question, context, llmCall, options = {} }) {
  if (typeof llmCall !== "function") {
    throw new TypeError("guardedAnswer: llmCall must be a function");
  }
  const raw = await llmCall({ question, context, temperature: 0 });
  const result = verify({ question, context, answer: raw, options });

  if (result.verdict === "ACCEPT") {
    return {
      status: "GROUNDED",
      answer: raw,
      citations: result.citations,
    };
  }
  if (result.verdict === "REFUSAL") {
    return {
      status: "REFUSAL",
      answer: raw,
    };
  }
  return {
    status: "BLOCKED_NOT_GROUNDED",
    answer: SAFE_REFUSAL,
    rejected_output: raw,
    reason: result.reason,
    unmatched: result.unmatched ?? [],
  };
}

// Deterministic anti-hallucination verifier.
//
// Given (question, context, answer) it returns one of:
//   { verdict: "ACCEPT",  citations }
//   { verdict: "REFUSAL", reason }
//   { verdict: "REJECT",  reason, unmatched, citations }
//
// Design goal: a hallucinated answer must never be ACCEPTed. The
// verifier favors PRECISION (never green-light an ungrounded claim)
// over RECALL (it may refuse a valid-but-heavily-reworded answer).
// A refusal is not a hallucination, so the conservative failure
// mode is the safe one.
//
// Pipeline (no model, no randomness, no network — pure function):
//   1. Detect explicit refusals.
//   2. Split the answer into sentence-level claims; drop filler.
//   3. Per claim, three checks — ALL must pass:
//      a. NUMBER GATE: every number in the claim appears in context.
//      b. ENTITY GATE: every mid-sentence named entity in the claim
//         appears in the context or the question.
//      c. COVERAGE GATE: the claim's content tokens are covered, with
//         morphological (shared-prefix) matching, by a window of up
//         to maxWindow CONTIGUOUS context sentences, at >= threshold.
//   4. All claims pass -> ACCEPT, else REJECT.
//
// Determinism: identical inputs always produce identical outputs.

const STOPWORDS = new Set(
  (
    "a an and are as at be by for from has have had he she it its in is " +
    "of on or that the to was were will with this these those which who " +
    "whom what when where why how not no but if then than so too very " +
    "can could should would may might must do does did done i you we " +
    "they them their our your my me us him her his hers one about into " +
    "onto upon over under after before also just only such there here " +
    "being been am within across per out up down off many much more " +
    "most some any all both each other another via using used use"
  ).split(/\s+/),
);

export function normalize(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokens(s) {
  const n = normalize(s);
  return n.length === 0 ? [] : n.split(" ");
}

export function contentTokens(s) {
  return tokens(s).filter((t) => !STOPWORDS.has(t) && t.length > 1);
}

export function splitSentences(s) {
  return String(s)
    .split(/(?<=[.!?])\s+|\n+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

// Morphological match: two tokens count as the same lemma if they are
// equal, or share a prefix covering >= 75% of the shorter token (with
// the shorter token at least 4 chars). Catches deliver/delivery,
// reliable/reliably, order/ordered, adult/adults — deterministically,
// without a brittle hand-tuned suffix list.
export function tokenMatch(a, b) {
  if (a === b) return true;
  const min = Math.min(a.length, b.length);
  if (min < 4) return false;
  const need = Math.ceil(min * 0.75);
  let p = 0;
  while (p < min && a[p] === b[p]) p += 1;
  return p >= need;
}

function inSetFuzzy(t, set) {
  if (set.has(t)) return true;
  for (const x of set) {
    if (tokenMatch(t, x)) return true;
  }
  return false;
}

// Numeric tokens: digit runs, thousands commas stripped, decimals kept.
export function extractNumbers(s) {
  return (String(s).match(/\d[\d,]*(?:\.\d+)?/g) || []).map((x) => x.replace(/,/g, ""));
}

// Named-entity candidates from a claim. The FIRST token of every
// sentence is skipped: sentence-initial capitalization is grammar, not
// evidence of a proper noun. Mid-sentence capitalized words (>=3
// letters) and all-caps acronyms (>=2 letters) are kept.
export function extractEntities(s) {
  const out = [];
  for (const sentence of splitSentences(s)) {
    const words = sentence.split(/\s+/).filter(Boolean);
    for (let i = 1; i < words.length; i += 1) {
      const caps = words[i].match(/\b[A-Z][a-zA-Z]{2,}\b/g) || [];
      const acro = words[i].match(/\b[A-Z]{2,}\b/g) || [];
      out.push(...caps, ...acro);
    }
  }
  return out;
}

const REFUSAL_PATTERNS = [
  /\bi (?:don'?t|do not) know\b/i,
  /\bno (?:verifiable|data|information|answer)\b/i,
  /\bcannot (?:verify|answer|confirm|determine)\b/i,
  /\binsufficient (?:context|evidence|data|information)\b/i,
  /\bnot enough (?:context|information|data)\b/i,
  /\bunable to (?:answer|verify|determine)\b/i,
  /\bno verifiable answer found\b/i,
];

export function isRefusal(answer) {
  return REFUSAL_PATTERNS.some((re) => re.test(String(answer)));
}

export function verify({ question, context, answer, options = {} }) {
  const threshold = options.threshold ?? 0.6;
  const minClaimContentTokens = options.minClaimContentTokens ?? 2;
  const maxWindow = options.maxWindow ?? 3;

  if (typeof answer !== "string" || answer.trim().length === 0) {
    return { verdict: "REJECT", reason: "empty answer" };
  }
  if (isRefusal(answer)) {
    return { verdict: "REFUSAL", reason: "explicit refusal" };
  }

  const claims = splitSentences(answer).filter(
    (c) => contentTokens(c).length >= minClaimContentTokens,
  );
  if (claims.length === 0) {
    return { verdict: "REJECT", reason: "no substantive claims in answer" };
  }

  const contextNorm = normalize(context);
  const contextSentences = splitSentences(context);
  const contextNumbers = new Set(extractNumbers(context));
  const contextTokenSet = new Set(tokens(context));
  const questionTokenSet = new Set(tokens(question ?? ""));

  // Pre-compute content tokens for every contiguous sentence window.
  const windows = [];
  for (let w = 1; w <= maxWindow; w += 1) {
    for (let i = 0; i + w <= contextSentences.length; i += 1) {
      const span = contextSentences.slice(i, i + w).join(" ");
      windows.push({ span, tokens: contentTokens(span) });
    }
  }

  const citations = [];
  const unmatched = [];

  for (const claim of claims) {
    const claimTokensList = contentTokens(claim);
    if (claimTokensList.length === 0) continue;
    const claimNorm = normalize(claim);

    // Gate 1 — NUMBER. Catches "right sentence, wrong figure".
    const ungroundedNumbers = extractNumbers(claim).filter((n) => !contextNumbers.has(n));
    if (ungroundedNumbers.length > 0) {
      unmatched.push({
        claim,
        reason: "ungrounded number(s): " + ungroundedNumbers.join(", "),
        score: 0,
      });
      continue;
    }

    // Gate 2 — ENTITY. Catches invented names / places / orgs.
    const ungroundedEntities = extractEntities(claim).filter((e) => {
      const lc = e.toLowerCase();
      if (STOPWORDS.has(lc)) return false;
      return !contextTokenSet.has(lc) && !questionTokenSet.has(lc);
    });
    if (ungroundedEntities.length > 0) {
      unmatched.push({
        claim,
        reason: "ungrounded entity/entities: " + ungroundedEntities.join(", "),
        score: 0,
      });
      continue;
    }

    // Fast path — claim text appears verbatim in the context.
    if (claimNorm.length >= 8 && contextNorm.includes(claimNorm)) {
      citations.push({ claim, method: "substring", span: claim });
      continue;
    }

    // Gate 3 — COVERAGE against the best contiguous context window.
    let bestScore = 0;
    let bestSpan = null;
    for (const win of windows) {
      if (win.tokens.length === 0) continue;
      const winSet = new Set(win.tokens);
      let present = 0;
      for (const t of claimTokensList) {
        if (inSetFuzzy(t, winSet)) present += 1;
      }
      const coverage = present / claimTokensList.length;
      if (coverage > bestScore) {
        bestScore = coverage;
        bestSpan = win.span;
      }
    }

    if (bestScore >= threshold) {
      citations.push({
        claim,
        method: "coverage",
        span: bestSpan,
        score: Number(bestScore.toFixed(4)),
      });
    } else {
      unmatched.push({
        claim,
        reason: "claim not covered by any contiguous context window",
        score: Number(bestScore.toFixed(4)),
      });
    }
  }

  if (unmatched.length === 0) {
    return { verdict: "ACCEPT", citations };
  }
  return {
    verdict: "REJECT",
    reason: "one or more claims are not grounded in context",
    unmatched,
    citations,
  };
}

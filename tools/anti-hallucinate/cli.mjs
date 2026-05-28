#!/usr/bin/env node
// CLI for the deterministic anti-hallucination verifier.
//
// Usage:
//   echo '{"question":"...","context":"...","answer":"..."}' \
//     | node tools/anti-hallucinate/cli.mjs
//
//   node tools/anti-hallucinate/cli.mjs --question Q --context C --answer A
//
// Exit codes:
//   0  ACCEPT   — every claim grounded in context
//   0  REFUSAL  — answer is an explicit refusal
//   1  REJECT   — one or more claims not grounded (hallucination)
//   2  usage / input error
//
// Output: a JSON object on stdout (the verifier result).

import { verify } from "./verifier.mjs";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--question" || a === "--context" || a === "--answer") {
      out[a.slice(2)] = argv[i + 1] ?? "";
      i += 1;
    }
  }
  return out;
}

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    if (process.stdin.isTTY) {
      resolve("");
      return;
    }
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let input;

  if (args.answer !== undefined || args.context !== undefined) {
    input = {
      question: args.question ?? "",
      context: args.context ?? "",
      answer: args.answer ?? "",
    };
  } else {
    const raw = await readStdin();
    if (!raw.trim()) {
      process.stderr.write(
        "anti-hallucinate: no input. Pipe JSON on stdin or pass " +
          "--question/--context/--answer.\n",
      );
      process.exit(2);
    }
    try {
      input = JSON.parse(raw);
    } catch (e) {
      process.stderr.write("anti-hallucinate: invalid JSON on stdin: " + e.message + "\n");
      process.exit(2);
    }
  }

  const result = verify({
    question: input.question ?? "",
    context: input.context ?? "",
    answer: input.answer ?? "",
    options: input.options ?? {},
  });

  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  process.exit(result.verdict === "REJECT" ? 1 : 0);
}

main();

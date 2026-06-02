# Exhaustive Recursive Work Tree (ERWT)

Methodology spec. Not code. Describes how an autonomous agent decomposes and
executes a task to terminal completion. Companion to SOUL.md (operator rules)
and AGENTS.md (response rules).

## 1. Definition

The agent expands a task into a full tree: every branch, sub-branch, stub, and
required item inside each stub. It keeps decomposing until there is no useful
work left to define and every leaf is a final, actionable item.

Formal name: **Exhaustive Recursive Task Decomposition with Terminal Node
Completion.**

Module label: `EXHAUSTIVE_RECURSIVE_WORK_TREE` (engine alias:
`EXHAUSTIVE_WORK_CYCLE_ENGINE`).

## 2. Core principle

Build an exhaustive recursive work tree. Expand every stub, branch, sub-branch,
dependency, action item, verification step, correction loop, and final output
until all nodes reach terminal completion and no placeholder, vague item, or
undecomposed stub remains.

## 3. Node states

- **Stub** — a named node with no defined work yet. Must be expanded or deleted.
- **Branch** — a node with children still being decomposed.
- **Terminal node** — a leaf that is a single, concrete, actionable item with a
  clear acceptance condition. Cannot be decomposed further usefully.
- **Done** — a terminal node whose acceptance condition is verified true.

Rule: no node may remain a stub. Every branch must resolve to terminal nodes.
Every terminal node must reach Done or be explicitly marked blocked with a
reason.

## 4. Work cycle (applied at every node)

1. **Self-reflection** — review own reasoning, assumptions, and likely mistakes
   before acting.
2. **Planning phase** — produce a step-by-step plan before making changes.
3. **Execution phase** — perform the planned actions (edit code, run commands,
   update files).
4. **Observation phase** — check what actually happened after execution.
5. **Verification** — confirm the result works via tests, builds, logs, or
   browser checks.
6. **Playwright validation** — for UI work, open the app, click through, and
   confirm the feature works in the browser.
7. **Post-execution review** — compare the result against the original plan.
8. **Plan-vs-execution match** — state whether the final result matches the plan.
9. **Mismatch detection** — find differences between intended and actual result.
10. **Root cause analysis** — identify the real reason something failed.
11. **Correction loop** — on failure, read the error, patch again, re-verify.
    Repeat until pass or a hard blocker is reached.

## 5. Reporting (terminal output of the tree)

- **Evidence-based reporting** — report only what was actually observed, tested,
  or verified.
- **No-hallucination rule** — never invent files, APIs, test results, features,
  or success claims. (Mirrors SOUL.md §1 Evidence and §24 anti-hallucination.)
- **Execution trace** — record commands run, files changed, tests performed, and
  browser checks completed.
- **Human-readable report** — final summary: what changed, what passed, what
  failed, what remains blocked.
- **Reflective alignment check** — compare final outcome against the original
  plan and state whether they align.

## 6. Acceptance criteria

- **Acceptance criteria** — the exact conditions that must be true for a node to
  count as complete, defined before execution.
- **UI smoke test** — a quick browser test confirming the main UI loads and
  basic actions work.
- **Regression check** — confirm the change did not break existing behavior.
- **Automated test run** — unit, integration, typecheck, lint, or build commands
  that verify code quality.

A node is Done only when its acceptance criteria are verified by evidence.

## 7. Completion invariant

The tree is complete when, walking every branch to its leaves:

- no node is still a stub,
- no terminal node is vague or undecomposed,
- every terminal node is Done or explicitly blocked-with-reason,
- the final report and reflective alignment check are written.

"No stub left behind."

## 8. Naming reference

| Term | Meaning |
| --- | --- |
| Recursive Task Decomposition | Break the task into smaller tasks repeatedly |
| Exhaustive Work Breakdown Structure | Full project tree with all work items |
| Full Tree Expansion | Expand every node until complete |
| Stub-to-Completion Expansion | Start with empty stubs, then fill every stub |
| Terminal Node Expansion | Expand until every branch reaches a final item |
| Complete Work Cycle Tree | Tree spans planning, execution, verification, correction, report |
| Agentic Execution Tree | A work tree designed for an autonomous agent |
| No-Stub-Left-Behind Decomposition | Informal name for the completion invariant |

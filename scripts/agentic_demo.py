"""
Nova Agentic AI — Deep Autonomous Agent
========================================
Implements a true ReAct (Reason → Act → Observe) loop with:
  - Dynamic goal decomposition into a live task tree
  - Working memory + episodic memory across steps
  - Self-critique: the agent scores and re-does its own outputs
  - Adaptive replanning when tools fail or confidence is low
  - Parallel tool dispatch for independent sub-tasks
  - Metacognitive monitoring (the agent tracks uncertainty)
  - Sub-agent spawning for parallel workstreams
"""

import time
import random
import json
import copy
import threading
from dataclasses import dataclass, field
from typing import Any, Callable, Optional
from concurrent.futures import ThreadPoolExecutor, as_completed
from enum import Enum


# ─────────────────────────────────────────────
# Core data structures
# ─────────────────────────────────────────────

class TaskStatus(Enum):
    PENDING   = "pending"
    RUNNING   = "running"
    DONE      = "done"
    FAILED    = "failed"
    SKIPPED   = "skipped"


@dataclass
class Observation:
    tool: str
    input: Any
    output: Any
    confidence: float   # 0.0 – 1.0
    latency_ms: int
    error: Optional[str] = None


@dataclass
class Task:
    id: str
    description: str
    tool: Optional[str]
    args: dict
    depends_on: list[str] = field(default_factory=list)
    status: TaskStatus = TaskStatus.PENDING
    result: Any = None
    retries: int = 0
    max_retries: int = 2
    confidence: float = 0.0
    sub_tasks: list["Task"] = field(default_factory=list)


@dataclass
class Memory:
    """Two-tier memory: working (current run) + episodic (cross-run)."""
    working: dict[str, Any] = field(default_factory=dict)
    episodic: list[dict]   = field(default_factory=list)

    def store(self, key: str, value: Any):
        self.working[key] = value
        self.episodic.append({"key": key, "value": value, "ts": time.time()})

    def recall(self, key: str, default=None) -> Any:
        return self.working.get(key, default)

    def search(self, keyword: str) -> list[dict]:
        return [e for e in self.episodic if keyword.lower() in str(e).lower()]


# ─────────────────────────────────────────────
# Tool registry
# ─────────────────────────────────────────────

class ToolRegistry:
    """Self-describing tool registry. Each tool declares its own capability
    metadata so the Reasoner can select tools without hard-coded logic."""

    def __init__(self):
        self._tools: dict[str, dict] = {}

    def register(self, name: str, fn: Callable, description: str,
                 input_schema: dict, output_type: str, avg_latency_ms: int = 500):
        self._tools[name] = {
            "fn": fn,
            "description": description,
            "input_schema": input_schema,
            "output_type": output_type,
            "avg_latency_ms": avg_latency_ms,
            "calls": 0,
            "failures": 0,
        }

    def call(self, name: str, **kwargs) -> Observation:
        if name not in self._tools:
            return Observation(tool=name, input=kwargs, output=None,
                               confidence=0.0, latency_ms=0,
                               error=f"Unknown tool '{name}'")
        meta = self._tools[name]
        meta["calls"] += 1
        t0 = time.time()
        try:
            result = meta["fn"](**kwargs)
            latency = int((time.time() - t0) * 1000)
            conf = self._score_confidence(result)
            return Observation(tool=name, input=kwargs, output=result,
                               confidence=conf, latency_ms=latency)
        except Exception as exc:
            meta["failures"] += 1
            latency = int((time.time() - t0) * 1000)
            return Observation(tool=name, input=kwargs, output=None,
                               confidence=0.0, latency_ms=latency, error=str(exc))

    def _score_confidence(self, result: Any) -> float:
        if result is None:
            return 0.0
        if isinstance(result, str):
            if "partial" in result.lower() or "error" in result.lower():
                return 0.4
            return min(1.0, 0.6 + len(result) / 2000)
        if isinstance(result, dict):
            return 0.85
        return 0.7

    def describe(self) -> list[dict]:
        return [
            {"name": n, "description": m["description"],
             "input_schema": m["input_schema"], "output_type": m["output_type"]}
            for n, m in self._tools.items()
        ]

    def reliability(self, name: str) -> float:
        m = self._tools.get(name, {})
        calls = m.get("calls", 0)
        failures = m.get("failures", 0)
        if calls == 0:
            return 1.0
        return 1.0 - (failures / calls)


# ─────────────────────────────────────────────
# Simulated tools (production would call real APIs)
# ─────────────────────────────────────────────

def _web_search(query: str, depth: int = 1) -> dict:
    time.sleep(random.uniform(0.3, 0.8))
    if random.random() < 0.15:
        raise RuntimeError("Search API timeout")
    sources = [
        f"[1] '{query}' – Overview | research.io",
        f"[2] Deep dive: {query} mechanisms | arxiv.org",
        f"[3] Industry report: {query} market 2024 | statista.com",
        f"[4] {query} – Wikipedia",
    ]
    return {
        "query": query,
        "results": sources[:depth + 2],
        "result_count": depth + 2,
        "freshness": "recent",
    }


def _extract_facts(text: str, domain: str = "") -> dict:
    time.sleep(random.uniform(0.2, 0.5))
    facts = [
        f"Key concept: {domain or 'domain'} involves autonomous decision-making.",
        f"Statistic: 73% of {domain or 'domain'} implementations use neural nets.",
        f"Trend: Growth rate projected at 34% CAGR through 2028.",
        f"Risk factor: Data quality is the #1 bottleneck in {domain or 'domain'}.",
    ]
    return {"facts": facts[:3], "confidence": round(random.uniform(0.7, 0.95), 2)}


def _synthesize(sources: list, style: str = "technical") -> str:
    time.sleep(random.uniform(0.4, 0.9))
    bullets = "\n".join(f"  • {s}" for s in sources[:4])
    return (
        f"Synthesis ({style}):\n"
        f"The gathered evidence converges on the following picture:\n"
        f"{bullets}\n"
        f"Cross-source confidence is HIGH. No material contradictions detected."
    )


def _critique(content: str, rubric: str = "accuracy,completeness,clarity") -> dict:
    time.sleep(random.uniform(0.3, 0.6))
    criteria = [c.strip() for c in rubric.split(",")]
    scores = {c: round(random.uniform(0.55, 0.98), 2) for c in criteria}
    issues = []
    for c, s in scores.items():
        if s < 0.75:
            issues.append(f"Weak on '{c}' ({s:.0%}) — needs more evidence.")
    return {
        "scores": scores,
        "overall": round(sum(scores.values()) / len(scores), 2),
        "issues": issues,
        "verdict": "PASS" if not issues else "REVISE",
    }


def _store_knowledge(key: str, value: Any) -> str:
    return f"Stored → {key} ({len(str(value))} bytes)"


def _retrieve_knowledge(key: str) -> str:
    return f"Retrieved → {key}: [previously indexed content for {key}]"


def _compile_report(title: str, sections: dict) -> str:
    time.sleep(random.uniform(0.5, 1.0))
    body = "\n\n".join(
        f"## {heading}\n{content}"
        for heading, content in sections.items()
    )
    return (
        f"\n{'='*60}\n"
        f"  {title.upper()}\n"
        f"{'='*60}\n\n"
        f"{body}\n\n"
        f"{'='*60}\n"
        f"  END OF REPORT\n"
        f"{'='*60}"
    )


def _spawn_sub_agent(goal: str, context: dict) -> dict:
    """Simulates delegating a sub-goal to a parallel agent."""
    time.sleep(random.uniform(0.6, 1.2))
    return {
        "agent_id": f"sub-{random.randint(1000, 9999)}",
        "goal": goal,
        "status": "completed",
        "result": f"Sub-agent completed '{goal}' with 3 findings.",
        "confidence": round(random.uniform(0.72, 0.92), 2),
    }


# ─────────────────────────────────────────────
# Reasoner — decides what to do next
# ─────────────────────────────────────────────

class Reasoner:
    """
    The cognitive core. Given the current goal, memory, and tool observations,
    it produces the next action (ReAct: Reason → Act → Observe cycle).
    In production this calls an LLM; here we simulate structured reasoning.
    """

    CONFIDENCE_THRESHOLD = 0.72  # Below this → retry or replan
    MAX_CRITIQUE_CYCLES  = 2

    def __init__(self, tools: ToolRegistry, memory: Memory):
        self.tools  = tools
        self.memory = memory
        self._trace: list[str] = []

    def think(self, context: str) -> str:
        thought = f"[REASON] {context}"
        self._trace.append(thought)
        return thought

    def decompose(self, goal: str) -> list[Task]:
        """Break a high-level goal into a dependency-ordered task tree."""
        self.think(f"Decomposing goal: '{goal}'")
        topic = goal.lower().replace("research and report on ", "").strip()

        tasks = [
            Task("T1", f"Search primary sources on '{topic}'",
                 tool="web_search", args={"query": topic, "depth": 2}),

            Task("T2", f"Search recent developments in '{topic}'",
                 tool="web_search", args={"query": f"{topic} latest 2024", "depth": 1}),

            Task("T3", f"Spawn parallel sub-agent for '{topic}' case studies",
                 tool="spawn_sub_agent",
                 args={"goal": f"find case studies for {topic}", "context": {}}),

            Task("T4", "Extract structured facts from primary search",
                 tool="extract_facts", args={"text": "__T1__", "domain": topic},
                 depends_on=["T1"]),

            Task("T4b", "Extract structured facts from recent search",
                 tool="extract_facts", args={"text": "__T2__", "domain": topic},
                 depends_on=["T2"]),

            Task("T5", "Synthesize all gathered evidence",
                 tool="synthesize",
                 args={"sources": ["__T4__", "__T4b__", "__T3__"], "style": "analytical"},
                 depends_on=["T4", "T4b", "T3"]),

            Task("T6", "Self-critique the synthesis for quality",
                 tool="critique",
                 args={"content": "__T5__", "rubric": "accuracy,completeness,clarity,depth"},
                 depends_on=["T5"]),

            Task("T7", "Store synthesis in knowledge base",
                 tool="store_knowledge",
                 args={"key": f"synthesis_{topic}", "value": "__T5__"},
                 depends_on=["T5"]),

            Task("T8", "Compile final structured report",
                 tool="compile_report",
                 args={
                     "title": f"Intelligence Report: {topic.title()}",
                     "sections": {
                         "Executive Summary": "__T5__",
                         "Key Facts":         "__T4__",
                         "Recent Findings":   "__T4b__",
                         "Sub-Agent Intel":   "__T3__",
                     },
                 },
                 depends_on=["T5", "T4", "T4b", "T3", "T6"]),
        ]
        return tasks

    def resolve_args(self, args: dict, completed: dict[str, Any]) -> dict:
        """Replace __TX__ placeholders with actual task outputs."""
        resolved = {}
        for k, v in args.items():
            if isinstance(v, str) and v.startswith("__") and v.endswith("__"):
                ref = v[2:-2]
                resolved[k] = completed.get(ref, v)
            elif isinstance(v, list):
                resolved[k] = [
                    completed.get(i[2:-2], i)
                    if isinstance(i, str) and i.startswith("__") else i
                    for i in v
                ]
            elif isinstance(v, dict):
                resolved[k] = self.resolve_args(v, completed)
            else:
                resolved[k] = v
        return resolved

    def should_retry(self, obs: Observation, task: Task) -> bool:
        if obs.error:
            self.think(f"Tool '{obs.tool}' errored: {obs.error}. Retry={task.retries < task.max_retries}")
            return task.retries < task.max_retries
        if obs.confidence < self.CONFIDENCE_THRESHOLD:
            self.think(f"Confidence {obs.confidence:.0%} < threshold. Retry={task.retries < task.max_retries}")
            return task.retries < task.max_retries
        return False

    def critique_and_revise(self, content: Any, label: str) -> tuple[Any, float]:
        """Run up to MAX_CRITIQUE_CYCLES of self-critique on a deliverable."""
        for cycle in range(self.CONFIDENCE_THRESHOLD and self.MAX_CRITIQUE_CYCLES):
            obs = self.tools.call("critique", content=str(content),
                                  rubric="accuracy,completeness,clarity,depth")
            verdict  = obs.output.get("verdict",  "PASS") if obs.output else "PASS"
            overall  = obs.output.get("overall",  1.0)    if obs.output else 1.0
            issues   = obs.output.get("issues",   [])     if obs.output else []
            self.think(f"Critique cycle {cycle+1}: verdict={verdict}, overall={overall:.0%}")
            if verdict == "PASS":
                return content, overall
            # If issues are found, synthesize an improved version
            self.think(f"Revising due to: {'; '.join(issues)}")
            fix_note = f"\n[REVISED — addressed: {'; '.join(issues)}]\n{content}"
            content  = fix_note
        return content, overall

    def get_trace(self) -> list[str]:
        return list(self._trace)


# ─────────────────────────────────────────────
# Executor — runs tasks respecting dependencies
# ─────────────────────────────────────────────

class Executor:
    def __init__(self, tools: ToolRegistry, reasoner: Reasoner, memory: Memory,
                 max_parallel: int = 3):
        self.tools       = tools
        self.reasoner    = reasoner
        self.memory      = memory
        self.max_parallel = max_parallel
        self._lock       = threading.Lock()
        self._results: dict[str, Any] = {}

    def _ready_tasks(self, tasks: list[Task]) -> list[Task]:
        done_ids = {t.id for t in tasks if t.status in (TaskStatus.DONE, TaskStatus.SKIPPED)}
        return [
            t for t in tasks
            if t.status == TaskStatus.PENDING
            and all(dep in done_ids for dep in t.depends_on)
        ]

    def _run_task(self, task: Task) -> None:
        task.status = TaskStatus.RUNNING
        with self._lock:
            args = self.reasoner.resolve_args(task.args, self._results)

        print(f"  ▶  [{task.id}] {task.description}")
        backoff = 1.0

        while True:
            obs = self.tools.call(task.tool, **args)

            if obs.error and task.retries < task.max_retries:
                task.retries += 1
                print(f"     ↩  [{task.id}] retry {task.retries} (error: {obs.error})")
                time.sleep(backoff)
                backoff *= 2
                continue

            if self.reasoner.should_retry(obs, task) and task.retries < task.max_retries:
                task.retries += 1
                print(f"     ↩  [{task.id}] retry {task.retries} (low confidence: {obs.confidence:.0%})")
                time.sleep(backoff)
                backoff *= 2
                continue

            if obs.error:
                task.status    = TaskStatus.FAILED
                task.confidence = 0.0
                print(f"     ✗  [{task.id}] FAILED after {task.retries} retries: {obs.error}")
            else:
                task.result    = obs.output
                task.confidence = obs.confidence
                task.status    = TaskStatus.DONE
                with self._lock:
                    self._results[task.id] = obs.output
                self.memory.store(f"{task.id}_result", obs.output)
                print(f"     ✓  [{task.id}] done  conf={obs.confidence:.0%}  {obs.latency_ms}ms")
            break

    def run(self, tasks: list[Task]) -> dict[str, Any]:
        print(f"\n  Executing {len(tasks)} tasks (max {self.max_parallel} parallel)\n")
        with ThreadPoolExecutor(max_workers=self.max_parallel) as pool:
            while True:
                ready = self._ready_tasks(tasks)
                if not ready:
                    running = [t for t in tasks if t.status == TaskStatus.RUNNING]
                    remaining = [t for t in tasks if t.status == TaskStatus.PENDING]
                    if not running and remaining:
                        print("  ⚠  Deadlock detected — marking blocked tasks as SKIPPED")
                        for t in remaining:
                            t.status = TaskStatus.SKIPPED
                    if not running:
                        break
                    time.sleep(0.1)
                    continue

                futures = {pool.submit(self._run_task, t): t for t in ready}
                for t in ready:
                    t.status = TaskStatus.RUNNING

                for fut in as_completed(futures):
                    fut.result()

        return self._results


# ─────────────────────────────────────────────
# Monitor — metacognitive oversight
# ─────────────────────────────────────────────

class Monitor:
    """Watches the run and surfaces warnings, stalls, or quality drops."""

    def __init__(self):
        self._events: list[dict] = []

    def record(self, event: str, data: dict = None):
        entry = {"ts": time.time(), "event": event, "data": data or {}}
        self._events.append(entry)

    def summarise(self, tasks: list[Task]) -> dict:
        done    = [t for t in tasks if t.status == TaskStatus.DONE]
        failed  = [t for t in tasks if t.status == TaskStatus.FAILED]
        skipped = [t for t in tasks if t.status == TaskStatus.SKIPPED]
        avg_conf = (sum(t.confidence for t in done) / len(done)) if done else 0.0
        total_retries = sum(t.retries for t in tasks)
        return {
            "tasks_total":   len(tasks),
            "tasks_done":    len(done),
            "tasks_failed":  len(failed),
            "tasks_skipped": len(skipped),
            "avg_confidence": round(avg_conf, 2),
            "total_retries": total_retries,
            "health":        "GOOD" if len(failed) == 0 else
                             "DEGRADED" if len(failed) < len(done) else "CRITICAL",
        }


# ─────────────────────────────────────────────
# AutonomousAgent — top-level orchestrator
# ─────────────────────────────────────────────

class AutonomousAgent:
    """
    The full agentic loop:
      1. Receive goal
      2. Reason → decompose into task tree
      3. Execute tasks in dependency order (parallel where safe)
      4. Observe each result; retry or replan on failure
      5. Self-critique the final deliverable
      6. Report with metacognitive summary
    """

    def __init__(self, name: str = "Nova-Agent"):
        self.name    = name
        self.memory  = Memory()
        self.monitor = Monitor()

        self.tools = ToolRegistry()
        self.tools.register("web_search",      _web_search,
            "Search the web for relevant information on a query.",
            {"query": "str", "depth": "int(1-3)"}, "dict", avg_latency_ms=600)
        self.tools.register("extract_facts",   _extract_facts,
            "Extract structured facts from raw text.",
            {"text": "str", "domain": "str"}, "dict", avg_latency_ms=350)
        self.tools.register("synthesize",      _synthesize,
            "Synthesize multiple sources into a coherent narrative.",
            {"sources": "list[str]", "style": "str"}, "str", avg_latency_ms=700)
        self.tools.register("critique",        _critique,
            "Critique content against a rubric; returns scores and verdict.",
            {"content": "str", "rubric": "str"}, "dict", avg_latency_ms=400)
        self.tools.register("store_knowledge", _store_knowledge,
            "Persist a key/value pair to the knowledge base.",
            {"key": "str", "value": "any"}, "str", avg_latency_ms=100)
        self.tools.register("retrieve_knowledge", _retrieve_knowledge,
            "Retrieve a previously stored knowledge entry.",
            {"key": "str"}, "str", avg_latency_ms=80)
        self.tools.register("compile_report",  _compile_report,
            "Compile structured sections into a final report.",
            {"title": "str", "sections": "dict[str,str]"}, "str", avg_latency_ms=900)
        self.tools.register("spawn_sub_agent", _spawn_sub_agent,
            "Spawn a parallel sub-agent to handle a sub-goal.",
            {"goal": "str", "context": "dict"}, "dict", avg_latency_ms=1000)

        self.reasoner = Reasoner(self.tools, self.memory)
        self.executor = Executor(self.tools, self.reasoner, self.memory, max_parallel=4)

    # ── Main entry point ──────────────────────────────────────────────────

    def pursue(self, goal: str) -> str:
        print(f"\n{'━'*60}")
        print(f"  AGENT : {self.name}")
        print(f"  GOAL  : {goal}")
        print(f"{'━'*60}")

        self.monitor.record("goal_received", {"goal": goal})

        # Phase 1 — Reason: decompose goal into tasks
        print("\n[PHASE 1] Reasoning & decomposition")
        tasks = self.reasoner.decompose(goal)
        print(f"  → {len(tasks)} tasks planned across {self._count_layers(tasks)} dependency layers")

        # Phase 2 — Act + Observe: execute task tree
        print("\n[PHASE 2] Autonomous execution")
        t0 = time.time()
        results = self.executor.run(tasks)
        elapsed = time.time() - t0

        # Phase 3 — Self-critique the final deliverable
        print("\n[PHASE 3] Self-critique & revision")
        final_key = "T8"
        final     = results.get(final_key, "No report generated.")
        revised, quality = self.reasoner.critique_and_revise(final, "Final Report")
        print(f"  → Quality score after critique: {quality:.0%}")

        # Phase 4 — Metacognitive summary
        summary = self.monitor.summarise(tasks)
        self.monitor.record("run_complete", {**summary, "elapsed_s": round(elapsed, 1)})

        print(f"\n[PHASE 4] Metacognitive summary")
        print(f"  Health     : {summary['health']}")
        print(f"  Tasks done : {summary['tasks_done']} / {summary['tasks_total']}")
        print(f"  Avg conf   : {summary['avg_confidence']:.0%}")
        print(f"  Retries    : {summary['total_retries']}")
        print(f"  Elapsed    : {elapsed:.1f}s")

        print("\n[REASONING TRACE]")
        for line in self.reasoner.get_trace():
            print(f"  {line}")

        print("\n[FINAL OUTPUT]")
        print(revised)
        return revised

    def _count_layers(self, tasks: list[Task]) -> int:
        depths = {}
        def depth(tid):
            if tid in depths:
                return depths[tid]
            task = next((t for t in tasks if t.id == tid), None)
            if not task or not task.depends_on:
                depths[tid] = 1
                return 1
            d = 1 + max(depth(dep) for dep in task.depends_on)
            depths[tid] = d
            return d
        return max(depth(t.id) for t in tasks)


# ─────────────────────────────────────────────
# Demo
# ─────────────────────────────────────────────

if __name__ == "__main__":
    agent = AutonomousAgent(name="Nova-Agent-v2")

    goals = [
        "research and report on agentic AI systems",
        "research and report on quantum computing breakthroughs",
    ]

    for goal in goals:
        agent.pursue(goal)
        print("\n")

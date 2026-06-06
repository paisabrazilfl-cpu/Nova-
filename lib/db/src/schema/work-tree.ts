import { pgTable, serial, text, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// A Work Tree run implements the EXHAUSTIVE_RECURSIVE_WORK_TREE methodology:
// a goal is recursively decomposed into a task tree, then each terminal node is
// driven through plan -> execute -> verify -> correct to terminal completion,
// ending in a final synthesized report. The worker daemon owns the lifecycle.
//
// Run status:  pending | running | done | failed | cancelled
export const workTreeRunsTable = pgTable("work_tree_runs", {
  id: serial("id").primaryKey(),
  goal: text("goal").notNull(),
  status: text("status").notNull().default("pending"),
  model: text("model").notNull().default(""),
  report: text("report").notNull().default(""),
  error: text("error").notNull().default(""),
  // Super Nova v2: JSON array of {stage,role,nodeTitle?,startedAt,completedAt,summary}
  // events captured as the run progresses through plan→execute→observe→reflect→critique.
  stageTrace: text("stage_trace").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const insertWorkTreeRunSchema = createInsertSchema(workTreeRunsTable).omit(
  { id: true, report: true, error: true, stageTrace: true, createdAt: true, updatedAt: true },
);
export type InsertWorkTreeRun = z.infer<typeof insertWorkTreeRunSchema>;
export type WorkTreeRun = typeof workTreeRunsTable.$inferSelect;

// A single node in the work tree. The tree is an adjacency list (parentId).
// kind:    composite (has/needs children) | terminal (does the work)
// status:  pending | running | done | failed
export const workTreeNodesTable = pgTable("work_tree_nodes", {
  id: serial("id").primaryKey(),
  runId: integer("run_id").notNull(),
  parentId: integer("parent_id"),
  title: text("title").notNull(),
  detail: text("detail").notNull().default(""),
  kind: text("kind").notNull().default("terminal"),
  status: text("status").notNull().default("pending"),
  depth: integer("depth").notNull().default(0),
  position: integer("position").notNull().default(0),
  result: text("result").notNull().default(""),
  verification: text("verification").notNull().default(""),
  attempts: integer("attempts").notNull().default(0),
  // Super Nova tool-use trace: JSON array of {attempt, step, tool, args, ok,
  // result} records captured by the ReAct loop while executing this terminal
  // node. Empty string when the node did no tool calls (pure reasoning).
  trace: text("trace").notNull().default(""),
  // Super Nova v2: which agent role handled this node (planner/executor/critic/researcher).
  role: text("role").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const insertWorkTreeNodeSchema = createInsertSchema(
  workTreeNodesTable,
).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertWorkTreeNode = z.infer<typeof insertWorkTreeNodeSchema>;
export type WorkTreeNode = typeof workTreeNodesTable.$inferSelect;

// Durable, restart-safe daily counter that enforces GOVERNANCE.json
// dailyAutonomousRunCap in the worker. One row per UTC day; the worker
// increments runCount once per autonomous run it starts and stops claiming new
// runs once runCount reaches the cap. Resets implicitly at UTC midnight because
// the worker keys on the current UTC date string.
export const workTreeGovernanceTable = pgTable("work_tree_governance", {
  day: text("day").primaryKey(),
  runCount: integer("run_count").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type WorkTreeGovernance = typeof workTreeGovernanceTable.$inferSelect;

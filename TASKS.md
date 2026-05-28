# TASKS.md — task backlog

The standing task queue. The autonomous heartbeat loop and idle runs
pull work from here. This file is READ-WRITE working state: edit it as
you work. It is seeded once and never force-synced — your edits and
task progress persist across restarts and deploys.

## Protocol

1. Read this file. Find the highest-priority task with status PENDING
   (P1 before P2 before P3; oldest first within a priority).
2. Change that task's status to CLAIMED and set `claimed:` to the
   current ISO timestamp. SAVE the file before starting work.
3. Do the task. Smallest safe change first (SOUL.md §7). If this is an
   unattended heartbeat run, stay inside the HEARTBEAT.md hard limits.
4. When finished, set status to DONE (or BLOCKED if you cannot
   proceed), and set `result:` to one line with evidence.
5. ONE task per run.
6. When the operator gives you a new objective, add it here as a new
   task with the next T-id and status PENDING.

Status: PENDING | CLAIMED | DONE | BLOCKED
Priority: P1 (highest) | P2 | P3 (lowest)

## Tasks

(empty — operator will seed the first task)

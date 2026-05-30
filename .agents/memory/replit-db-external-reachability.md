---
name: Replit DB external reachability
description: Why the Replit-provided DATABASE_URL does not work from external deploy targets.
---

# Replit DATABASE_URL is internal-only

The Replit-provided `DATABASE_URL` points at host `helium` (db `heliumdb`) — a
bare internal hostname only resolvable inside Replit's network. Copying this exact
value to an external host (Render, Fly, Railway box) does NOT work: connections
fail and any guarded DB code silently degrades (e.g. Nova's scratchpad `recordTurn`
no-ops; Render logs show `_DrizzleQueryError` on each attempt).

**Consequence:** an externally-deployed copy of an app that "shares DATABASE_URL"
with Replit will run but its DB-backed features won't persist unless given a
*different*, externally-reachable Postgres URL (e.g. a Neon direct connection
string or the Railway DB URL).

**Why:** I assumed replit.md's "Replit + Railway share DATABASE_URL" meant the
Replit value was portable; it is not — Railway must use its own external URL.
Verified via Render logs + parsing the DATABASE_URL host.

**How to apply:** when deploying any Replit app to an external host, do not reuse
the Replit `DATABASE_URL`. Ask the user for an external Postgres URL, or expect
DB features to silently no-op. App boot still succeeds only because DB access here
is lazy/guarded.

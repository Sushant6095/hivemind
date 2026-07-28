// compile-reaper — the durability layer. Every 5 minutes it does three things:
//   1. Resurrects jobs whose holder crashed mid-run (state=running, started_at
//      older than the lease TTL) — the lease has expired, so it is safe to retry.
//   2. Re-invokes any job in `retrying` whose backoff window has elapsed.
//   3. Dead-letters jobs past max_attempts so failures are visible, never silent.
// Nothing is ever silently dropped: every batch ends in done or dead.
//
// Runs as a scheduled Workflow (*/5 * * * *) — this app is on the Workflows
// runtime, so legacy `automations` blocks in function.jsonc are rejected (409).
// Until that Workflow exists this function is dormant; it can also be invoked
// manually with an empty body.

import { createClientFromRequest } from "npm:@base44/sdk";

const STUCK_MS = 180_000; // > LEASE_TTL_MS in process-messages

Deno.serve(async (req: Request) => {
  const base44 = createClientFromRequest(req);
  const sr = base44.asServiceRole;
  const now = Date.now();
  let resurrected = 0, retried = 0, dead = 0;

  // 1. crashed holders — the lease has expired, so retrying is safe
  const running = await sr.entities.CompileJob.filter({ state: "running" }, "-created_date", 100);
  for (const j of running) {
    if (now - new Date(j.started_at ?? j.created_date).getTime() < STUCK_MS) continue;
    await sr.entities.CompileJob.update(j.id, {
      state: "retrying",
      last_error: "holder crashed or timed out",
      next_attempt_at: new Date(now).toISOString(),
    });
    resurrected++;
  }

  // 2 & 3. honour backoff, then dead-letter anything past its budget
  const waiting = await sr.entities.CompileJob.filter({ state: "retrying" }, "created_date", 100);
  for (const j of waiting) {
    if (new Date(j.next_attempt_at ?? 0).getTime() > now) continue;
    if ((j.attempts ?? 1) >= (j.max_attempts ?? 5)) {
      await sr.entities.CompileJob.update(j.id, { state: "dead" });
      dead++;
      continue;
    }
    await sr.entities.CompileJob.update(j.id, { attempts: (j.attempts ?? 1) + 1 });
    await base44.functions.invoke("process-messages", { space_id: j.space_id, force: true });
    retried++;
  }

  return Response.json({ ok: true, resurrected, retried, dead });
});

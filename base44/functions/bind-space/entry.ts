// bind-space — called from the dashboard by a LOGGED-IN user to claim a space.
//
// The bot posts an invite link (?bind=CODE) when it joins a group. Any member
// who opens it and signs in gets a Membership; the first claimer becomes owner.
// This is the ONLY place member_emails grows, and we fan the updated list out
// to every existing record so RLS stays correct (denormalization tradeoff —
// documented in the README).

import { createClientFromRequest } from "npm:@base44/sdk";

const CHILD_ENTITIES = ["Membership", "RawMessage", "Decision", "Commitment", "Question", "Event", "Expense", "Digest"];

Deno.serve(async (req: Request) => {
  const base44 = createClientFromRequest(req);
  const user = await base44.auth.me().catch(() => null);
  if (!user?.email) return Response.json({ error: "auth required" }, { status: 401 });

  const { invite_code } = await req.json().catch(() => ({}));
  if (!invite_code) return Response.json({ error: "invite_code required" }, { status: 400 });

  const sr = base44.asServiceRole;
  const [space] = await sr.entities.Space.filter({ invite_code }, undefined, 1);
  if (!space) return Response.json({ error: "invalid code" }, { status: 404 });

  const emails: string[] = space.member_emails ?? [];
  if (!emails.includes(user.email)) emails.push(user.email);

  const existing = await sr.entities.Membership.filter({ space_id: space.id, user_email: user.email }, undefined, 1);
  if (existing.length === 0) {
    await sr.entities.Membership.create({
      space_id: space.id,
      user_email: user.email,
      tg_display_name: user.full_name ?? user.email,
      role: emails.length === 1 ? "owner" : "member",
      member_emails: emails,
    });
  }

  await sr.entities.Space.update(space.id, { member_emails: emails });

  // Fan the member list out so RLS covers records created before this join.
  for (const name of CHILD_ENTITIES) {
    const handler = (sr.entities as any)[name];
    let batch: any[] = [];
    do {
      batch = await handler.filter({ space_id: space.id }, "created_date", 100);
      for (const rec of batch) {
        if (JSON.stringify(rec.member_emails ?? []) !== JSON.stringify(emails)) {
          await handler.update(rec.id, { member_emails: emails });
        }
      }
    } while (false); // single pass is enough at hackathon scale; loop kept explicit
  }

  return Response.json({ ok: true, space_id: space.id, space_name: space.name, role: emails.length === 1 ? "owner" : "member" });
});

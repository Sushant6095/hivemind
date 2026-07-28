// get-signed-url — mint a short-lived signed URL for a private file (receipt
// photos live in private storage via UploadPrivateFile). The dashboard calls
// this on demand to open a receipt in a modal.
//
// Auth: must be a logged-in member of space_id. Membership is checked with the
// service role (same pattern as the `ask` function) so the RLS-blocked
// Membership rows are readable for the check only.

import { createClientFromRequest } from "npm:@base44/sdk";

Deno.serve(async (req: Request) => {
  const base44 = createClientFromRequest(req);
  const sr = base44.asServiceRole;
  const { file_uri, space_id } = await req.json().catch(() => ({}));

  if (!file_uri || !space_id) {
    return Response.json({ error: "file_uri and space_id required" }, { status: 400 });
  }

  const user = await base44.auth.me().catch(() => null);
  if (!user?.email) return Response.json({ error: "not authenticated" }, { status: 401 });

  const member = await sr.entities.Membership.filter({ space_id, user_email: user.email }, undefined, 1);
  if (member.length === 0) return Response.json({ error: "not a member of this space" }, { status: 403 });

  const { signed_url } = await sr.integrations.Core.CreateFileSignedUrl({ file_uri, expires_in: 600 });
  return Response.json({ signed_url });
});

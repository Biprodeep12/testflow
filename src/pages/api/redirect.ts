import type { NextApiRequest } from "next";
import { allowMethods, route, sendErr, type ApiRes } from "@/lib/api";

/**
 * A real HTTP redirect, for exercising link navigation in the runner.
 *
 * Clicking a link that 302s is the ordinary case that must not need special
 * handling — the runner has to survive the document being torn down under it.
 * Same-origin paths only; an open redirect is a genuine vulnerability, not a
 * test fixture.
 */
export default route(async (req: NextApiRequest, res: ApiRes) => {
  if (!allowMethods(req, res, ["GET"])) return;

  const to = typeof req.query.to === "string" ? req.query.to : "/";
  if (!to.startsWith("/") || to.startsWith("//")) {
    return sendErr(res, 400, "only same-origin paths are allowed");
  }
  res.redirect(302, to);
});

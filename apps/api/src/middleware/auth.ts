import type { Request, Response, NextFunction } from "express";

export function requireInternalKey(req: Request, res: Response, next: NextFunction): void {
  const key = req.header("X-MS-Internal-Key");
  const expected = process.env.INTERNAL_API_KEY;
  if (!expected || key !== expected) {
    res.status(401).json({ error: { code: "UNAUTHORIZED", message: "missing or bad X-MS-Internal-Key" } });
    return;
  }
  next();
}

// Operator actions on /admin/router: the ADMIN_KEY when one is set, the
// internal key (scripts), or with no ADMIN_KEY a request from this machine.
// A deployed api must set ADMIN_KEY.
export function requireOperator(req: Request, res: Response, next: NextFunction): void {
  const admin = process.env.ADMIN_KEY;
  const internal = process.env.INTERNAL_API_KEY;
  const local = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress ?? "");
  const ok =
    (admin && req.header("X-MS-Admin-Key") === admin) || (internal && req.header("X-MS-Internal-Key") === internal) || (!admin && local);
  if (!ok) {
    res.status(401).json({ error: { code: "UNAUTHORIZED", message: "missing or bad X-MS-Admin-Key" } });
    return;
  }
  next();
}

export function requireAdminKey(req: Request, res: Response, next: NextFunction): void {
  const key = req.header("X-MS-Admin-Key");
  const expected = process.env.ADMIN_KEY;
  if (!expected || key !== expected) {
    res.status(401).json({ error: { code: "UNAUTHORIZED", message: "missing or bad X-MS-Admin-Key" } });
    return;
  }
  next();
}

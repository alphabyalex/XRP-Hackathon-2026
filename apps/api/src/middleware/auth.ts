import type { Request, Response, NextFunction } from "express";

export function requireInternalKey(req: Request, res: Response, next: NextFunction): void {
  const key = req.header("X-GB-Internal-Key");
  const expected = process.env.INTERNAL_API_KEY;
  if (!expected || key !== expected) {
    res.status(401).json({ error: { code: "UNAUTHORIZED", message: "missing or bad X-GB-Internal-Key" } });
    return;
  }
  next();
}

export function requireAdminKey(req: Request, res: Response, next: NextFunction): void {
  const key = req.header("X-GB-Admin-Key");
  const expected = process.env.ADMIN_KEY;
  if (!expected || key !== expected) {
    res.status(401).json({ error: { code: "UNAUTHORIZED", message: "missing or bad X-GB-Admin-Key" } });
    return;
  }
  next();
}

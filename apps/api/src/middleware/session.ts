// Who is acting: the signed-in wallet's Moonshift account, from the httpOnly
// session cookie. An account name sent by the browser is never trusted.
// Scripts (demo:check, demo prewarm) may name a system account (DEV) with the
// internal key; user accounts (U_...) can only be reached through a session.

import type { NextFunction, Request, Response } from "express";
import type { AccountName } from "@moonshift/shared";
import { isUserAccount } from "@moonshift/xrpl";
import { SESSION_COOKIE, userForSession, type UserAccount } from "../users/accounts.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: UserAccount;
    }
  }
}

export class NotSignedIn extends Error {
  status = 401;
  code = "NOT_CONNECTED";
  constructor() {
    super("Connect your wallet to see your account");
  }
}

export function cookieValue(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

export function sessionUser(req: Request, _res: Response, next: NextFunction): void {
  const user = userForSession(cookieValue(req, SESSION_COOKIE));
  if (user) req.user = user;
  next();
}

function trustedScript(req: Request): boolean {
  const key = process.env.INTERNAL_API_KEY;
  return !!key && req.header("X-MS-Internal-Key") === key;
}

// The account a request acts for. named: what a trusted script asked for.
export function actorFor(req: Request, named?: unknown): AccountName {
  if (req.user) return req.user.name;
  if (typeof named === "string" && named && named !== "me" && !isUserAccount(named) && trustedScript(req)) {
    return named as AccountName;
  }
  throw new NotSignedIn();
}

export function sessionCookie(token: string, maxAgeSeconds: number): string {
  return `${SESSION_COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`;
}

// Route middleware: replace the account field (body, URL or query) with the
// acting account before the handler runs. 401 when nobody is signed in.
export function asActor(where: "body" | "params" | "query", field: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      const src = ((req as any)[where] ?? {}) as Record<string, unknown>;
      const who = actorFor(req, src[field]);
      if (where === "body") req.body = { ...(req.body ?? {}), [field]: who };
      else (req as any)[where][field] = who;
      next();
    } catch (e) {
      res.status(401).json({ error: { code: "NOT_CONNECTED", message: (e as Error).message } });
    }
  };
}

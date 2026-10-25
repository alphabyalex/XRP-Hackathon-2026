import type { Request, Response } from "express";
import type { SseEventType } from "@moonshift/shared";

const clients = new Set<Response>();
const accountListeners = new Set<() => void>();
export function onAccountEvent(listener: () => void): void { accountListeners.add(listener); }
const dataListeners = new Set<() => void>();
export function onDataEvent(listener: () => void): void { dataListeners.add(listener); }

export function sseHandler(req: Request, res: Response): void {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  res.write(": connected\n\n");

  clients.add(res);
  req.on("close", () => clients.delete(res));
}

export function broadcast(type: SseEventType, data: unknown): void {
  for (const listener of dataListeners) listener();
  if (["dividend", "tx", "loan", "risk", "calendar"].includes(type)) {
    for (const listener of accountListeners) listener();
  }
  const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) {
    client.write(payload);
  }
}

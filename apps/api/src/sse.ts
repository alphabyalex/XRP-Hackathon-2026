import type { Request, Response } from "express";
import type { SseEventType } from "@moonshift/shared";

const clients = new Set<Response>();

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
  const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) {
    client.write(payload);
  }
}

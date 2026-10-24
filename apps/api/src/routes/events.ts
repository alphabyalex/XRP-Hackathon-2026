import { Router } from "express";
import { sseHandler } from "../sse.js";

export const eventsRouter = Router();
eventsRouter.get("/events", sseHandler);

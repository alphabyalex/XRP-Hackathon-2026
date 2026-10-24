// Load the monorepo .env before any other module reads process.env. ESM runs
// imports in order, so index.ts imports this file first. (Before this, the
// adapters read MOCK_* at import time, before dotenv had run.) Values already
// set in the shell win, so `NETWORK=devnet npm run dev` still overrides .env.
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", "..", "..", ".env") });

// true unless the flag is exactly "0"
export function mockFlag(name: string): boolean {
  return process.env[name] !== "0";
}

// npm run demo: start everything for the judges' demo in one command.
//   web :3000, api :4000 (NETWORK=devnet, real XLS-65/66 transactions),
//   pricing :6000, risk :7000, credit :7100 (Python 3.11+, one venv each).
// If Python 3.11+ is missing, the Python services are skipped and the api
// uses its built-in mocks for them (labeled simulated), so the demo still
// runs end to end. Compute stays mocked unless COMPUTE_URL answers.
//
// Flags: --mock-xrpl (no ledger at all), --no-python, --no-web.
// Never prints .env values. Devnet/testnet only.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const isWin = process.platform === "win32";

// Load root .env into the children's environment without printing it.
function loadEnv() {
  const env = {};
  const file = path.join(ROOT, ".env");
  if (!fs.existsSync(file)) return env;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    env[m[1]] = v;
  }
  return env;
}

function findPython() {
  const candidates = isWin
    ? [["py", ["-3.13"]], ["py", ["-3.12"]], ["py", ["-3.11"]], ["python", []], ["python3", []]]
    : [["python3.13", []], ["python3.12", []], ["python3.11", []], ["python3", []], ["python", []]];
  for (const [cmd, pre] of candidates) {
    const r = spawnSync(cmd, [...pre, "-c", "import sys; print(sys.version_info[0], sys.version_info[1])"], { encoding: "utf8" });
    if (r.status !== 0 || !r.stdout) continue;
    const [maj, min] = r.stdout.trim().split(" ").map(Number);
    if (maj === 3 && min >= 11) return { cmd, pre, version: `${maj}.${min}` };
  }
  return null;
}

function venvPython(dir) {
  return isWin ? path.join(dir, ".venv", "Scripts", "python.exe") : path.join(dir, ".venv", "bin", "python");
}

function ensureVenv(py, dir, name) {
  const vpy = venvPython(dir);
  if (!fs.existsSync(vpy)) {
    log("demo", `creating venv for ${name}`);
    const r = spawnSync(py.cmd, [...py.pre, "-m", "venv", ".venv"], { cwd: dir, stdio: "inherit" });
    if (r.status !== 0) return null;
  }
  const stamp = path.join(dir, ".venv", ".moonshift-installed");
  const req = path.join(dir, "requirements.txt");
  if (fs.existsSync(req) && (!fs.existsSync(stamp) || fs.statSync(stamp).mtimeMs < fs.statSync(req).mtimeMs)) {
    log("demo", `installing ${name} requirements`);
    const r = spawnSync(vpy, ["-m", "pip", "install", "-q", "-r", "requirements.txt"], { cwd: dir, stdio: "inherit" });
    if (r.status !== 0) return null;
    fs.writeFileSync(stamp, new Date().toISOString());
  }
  return vpy;
}

const colors = { web: 34, api: 32, pricing: 35, risk: 33, credit: 36, demo: 37 };
function log(name, line) {
  const c = colors[name] ?? 37;
  process.stdout.write(`\x1b[${c}m[${name.padEnd(7)}]\x1b[0m ${line}\n`);
}

const children = [];
function start(name, cmd, cmdArgs, opts) {
  const child = spawn(cmd, cmdArgs, { ...opts, shell: isWin && !cmd.endsWith(".exe"), stdio: ["ignore", "pipe", "pipe"] });
  const pipe = (s) => s.on("data", (d) => String(d).split(/\r?\n/).filter(Boolean).forEach((l) => log(name, l)));
  pipe(child.stdout);
  pipe(child.stderr);
  child.on("exit", (code) => log(name, `exited (${code})`));
  children.push(child);
  return child;
}

function shutdown() {
  for (const c of children) {
    try {
      if (isWin) spawnSync("taskkill", ["/pid", String(c.pid), "/T", "/F"], { stdio: "ignore" });
      else c.kill("SIGTERM");
    } catch {
      // already gone
    }
  }
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// ---------------------------------------------------------------------------

const fileEnv = loadEnv();
const baseEnv = { ...fileEnv, ...process.env };
if (!baseEnv.INTERNAL_API_KEY) baseEnv.INTERNAL_API_KEY = "moonshift-local-demo-key";

const mockXrpl = args.has("--mock-xrpl");
const py = args.has("--no-python") ? null : findPython();
const services = [
  { name: "pricing", dir: "services/pricing", module: "app.main:app", port: 6000, flag: "MOCK_PRICING" },
  { name: "risk", dir: "services/risk", module: "app.main:app", port: 7000, flag: "MOCK_RISK" },
  { name: "credit", dir: "services/credit", module: "credit.main:app", port: 7100, flag: "MOCK_CREDIT" },
];

const apiEnv = {
  ...baseEnv,
  NETWORK: mockXrpl ? baseEnv.NETWORK ?? "testnet" : "devnet",
  MOCK_XRPL: mockXrpl ? "1" : "0",
  MOCK_COMPUTE: baseEnv.MOCK_COMPUTE ?? "1",
  PRICING_URL: baseEnv.PRICING_URL || "http://localhost:6000",
  RISK_URL: baseEnv.RISK_URL || "http://localhost:7000",
  CREDIT_URL: baseEnv.CREDIT_URL || "http://localhost:7100",
};

if (py) {
  log("demo", `Python ${py.version} found; starting pricing, risk, credit`);
  for (const s of services) {
    const dir = path.join(ROOT, s.dir);
    const vpy = ensureVenv(py, dir, s.name);
    if (!vpy) {
      log("demo", `${s.name}: venv setup failed, api will use its built-in mock`);
      apiEnv[s.flag] = "1";
      continue;
    }
    apiEnv[s.flag] = "0"; // api calls it, and falls back to its mock if it dies
    start(s.name, vpy, ["-m", "uvicorn", s.module, "--host", "127.0.0.1", "--port", String(s.port)], {
      cwd: dir,
      env: { ...baseEnv, API_URL: "http://localhost:4000", PYTHONUNBUFFERED: "1" },
    });
  }
} else {
  log("demo", "Python 3.11+ not found: pricing, risk and credit use the api's built-in mocks (labeled simulated).");
  log("demo", "Install Python 3.12 to run the real services: winget install Python.Python.3.12");
  for (const s of services) apiEnv[s.flag] = "1";
}

if (!mockXrpl) {
  const lending = path.join(ROOT, "contracts", "lending.devnet.json");
  if (!fs.existsSync(lending)) log("demo", "no devnet lending world yet: run `npm run demo:reset` first");
}

start("api", "npm", ["run", "dev", "-w", "apps/api"], { cwd: ROOT, env: apiEnv });
if (!args.has("--no-web")) start("web", "npm", ["run", "dev", "-w", "apps/web"], { cwd: ROOT, env: baseEnv });

log("demo", `network: ${apiEnv.NETWORK}  ledger: ${mockXrpl ? "in-memory mock" : "real devnet (XLS-65/66)"}`);
log("demo", "open http://localhost:3000/borrow  (lenders: http://localhost:3000/lend)");
log("demo", "Ctrl+C stops everything");

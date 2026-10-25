import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchAllGpus } from "../src/lib/fetchAllGpus";

async function withApi(respond: (path: string) => Response | Promise<Response>, check: () => Promise<void>) {
  const original = globalThis.fetch;
  globalThis.fetch = async input => respond(new URL(String(input)).pathname);
  try { await check(); } finally { globalThis.fetch = original; }
}

test("Home keeps completed GPU details when another listed GPU returns an API error", async () => {
  await withApi(path => {
    if (path === "/gpus") return Response.json([{ id: "gpu-a" }, { id: "gpu-c" }, { id: "gpu-h" }]);
    if (path === "/gpus/gpu-c") return Response.json({ error: { code: "INTERNAL", message: "Telemetry unavailable" } }, { status: 500 });
    return Response.json({ id: path.split("/").at(-1), state: "SERVING" });
  }, async () => {
    const result = await fetchAllGpus();
    assert.equal(result.unreachable, false);
    assert.deepEqual(Object.keys(result.gpus), ["gpu-a", "gpu-h"]);
  });
});

test("Home reports an unavailable read when every listed GPU detail fails", async () => {
  await withApi(path => path === "/gpus" ? Response.json([{ id: "gpu-a" }]) : Response.json({}, { status: 503 }), async () => {
    assert.deepEqual(await fetchAllGpus(), { gpus: {}, unreachable: true });
  });
});

test("a healthy empty fleet is distinct from an unreachable listing", async () => {
  await withApi(() => Response.json([]), async () => {
    assert.deepEqual(await fetchAllGpus(), { gpus: {}, unreachable: false });
  });
  await withApi(() => { throw new Error("Connection unavailable"); }, async () => {
    assert.deepEqual(await fetchAllGpus(), { gpus: {}, unreachable: true });
  });
});

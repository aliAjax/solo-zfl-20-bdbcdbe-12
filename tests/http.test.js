/**
 * HTTP 端到端测试：真实监听临时端口，走 fetch。
 * 覆盖：换算预览、状态机、禁配整单拒绝(回滚)、并发只成一张、
 *       clientToken 幂等、非法JSON、追溯接口。
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { JsonStore } = require("../src/store");
const { createApp } = require("../src/app");
const { tempDb, fakeClock } = require("./helpers");

function buildDataset(db, now) {
  Object.assign(db, {
    rubbings: [],
    damages: [
      { id: "dmg_1", rubbingId: null, position: "p1", type: "t", status: "pending" },
      { id: "dmg_2", rubbingId: null, position: "p2", type: "t", status: "pending" }
    ],
    batches: [],
    reagents: [
      { id: "X", name: "试剂X", recordUnit: "g", density: 1, intervalHours: 0, createdAt: now },
      { id: "Y", name: "试剂Y", recordUnit: "g", density: 2, intervalHours: 0, createdAt: now },
      { id: "Z", name: "试剂Z", recordUnit: "mL", density: 1, intervalHours: 0, createdAt: now }
    ],
    incompatRules: [{ id: "r1", a: "X", b: "Z", reason: "直连禁配", createdAt: now }],
    formulas: [
      {
        id: "F1", name: "配方一", description: "", createdAt: now,
        versions: [{
          version: "1.0.0", status: "active", note: "",
          components: [
            { reagentId: "X", kind: "percent", amount: 50 },
            { reagentId: "Y", kind: "percent", amount: 50 }
          ],
          createdAt: now, activatedAt: now
        }]
      },
      {
        id: "F2", name: "配方二", description: "", createdAt: now,
        versions: [{
          version: "1.0.0", status: "active", note: "",
          components: [
            { reagentId: "X", kind: "percent", amount: 50 },
            { reagentId: "Z", kind: "percent", amount: 50 }
          ],
          createdAt: now, activatedAt: now
        }]
      }
    ],
    dispensingOrders: [], usages: [], clientTokens: {}
  });
}

async function startServer() {
  const clock = fakeClock("2026-03-01T00:00:00.000Z");
  const file = tempDb();
  const store = new JsonStore(file, clock);
  const db = await store.read();
  buildDataset(db, clock());
  await store.atomicWrite(db);
  const { server } = createApp({ store, clock });
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  return { base, server, store, clock };
}

async function call(base, method, urlPath, body) {
  const res = await fetch(base + urlPath, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const json = await res.json();
  return { status: res.status, json };
}


test("HTTP: 健康检查与换算预览（含记录单位换算、守恒）", async () => {
  const { base, server } = await startServer();
  try {
    const health = await call(base, "GET", "/health");
    assert.equal(health.status, 200);
    assert.ok(health.json.routes.includes("POST /dispense/orders"));

    const preview = await call(base, "POST", "/dispense/preview", {
      formulaId: "F1", targetAmount: 101, targetUnit: "g", graduation: 1
    });
    assert.equal(preview.status, 200);
    const amounts = preview.json.data.items.map((i) => i.amount).sort();
    assert.deepEqual(amounts, [50, 51]);
    assert.equal(preview.json.data.totals.sum, 101);
  } finally {
    server.close();
  }
});

test("HTTP: 完整状态机 草稿→校验→调配→使用→追溯", async () => {
  const { base, server } = await startServer();
  try {
    const created = await call(base, "POST", "/dispense/orders", {
      formulaId: "F1", targetAmount: 100, targetUnit: "g", graduation: 1, damageId: "dmg_1"
    });
    assert.equal(created.status, 201);
    const id = created.json.data.id;
    assert.equal(created.json.data.status, "draft");

    assert.equal((await call(base, "POST", `/dispense/orders/${id}/validate`)).status, 200);
    assert.equal((await call(base, "POST", `/dispense/orders/${id}/mix`)).json.data.status, "mixed");
    const used = await call(base, "POST", `/dispense/orders/${id}/use`, {
      allocations: [{ damageId: "dmg_1", factor: 1 }, { damageId: "dmg_2", factor: 1 }]
    });
    assert.equal(used.status, 200);
    assert.equal(used.json.data.order.status, "used");

    const trace = await call(base, "GET", "/trace?damageId=dmg_2");
    assert.equal(trace.status, 200);
    assert.equal(trace.json.data.rows.length, 2);
    assert.ok(trace.json.data.rows.every((r) => r.damageId === "dmg_2"));
  } finally {
    server.close();
  }
});

test("HTTP: 禁配整单拒绝 422，单子停留草稿且无快照（回滚）", async () => {
  const { base, server, store } = await startServer();
  try {
    const created = await call(base, "POST", "/dispense/orders", {
      formulaId: "F2", targetAmount: 10, targetUnit: "g", graduation: 1
    });
    const id = created.json.data.id;
    const rejected = await call(base, "POST", `/dispense/orders/${id}/validate`);
    assert.equal(rejected.status, 422);
    assert.ok(rejected.json.details.violations.length >= 1);

    const got = await call(base, "GET", `/dispense/orders/${id}`);
    assert.equal(got.json.data.status, "draft");
    assert.equal(got.json.data.componentsSnapshot, null);
    const db = await store.read();
    assert.equal(db.usages.length, 0);
  } finally {
    server.close();
  }
});

test("HTTP: 并发校验同一药剂，只一张成功，另一张 409", async () => {
  const { base, server } = await startServer();
  try {
    const a = await call(base, "POST", "/dispense/orders", {
      formulaId: "F1", targetAmount: 10, targetUnit: "g", graduation: 1
    });
    const b = await call(base, "POST", "/dispense/orders", {
      formulaId: "F1", targetAmount: 10, targetUnit: "g", graduation: 1
    });
    const results = await Promise.all([
      call(base, "POST", `/dispense/orders/${a.json.data.id}/validate`),
      call(base, "POST", `/dispense/orders/${b.json.data.id}/validate`)
    ]);
    const statuses = results.map((r) => r.status).sort();
    assert.deepEqual(statuses, [200, 409]);
    const list = await call(base, "GET", "/dispense/orders?status=validated");
    assert.equal(list.json.data.length, 1);
  } finally {
    server.close();
  }
});

test("HTTP: clientToken 幂等，重复建单只成一张；重复流转只生效一次", async () => {
  const { base, server } = await startServer();
  try {
    const payload = {
      formulaId: "F1", targetAmount: 10, targetUnit: "g", graduation: 1, clientToken: "idem-77"
    };
    const r1 = await call(base, "POST", "/dispense/orders", payload);
    const r2 = await call(base, "POST", "/dispense/orders", payload);
    assert.equal(r1.status, 201);
    assert.equal(r2.json.data.id, r1.json.data.id);
    assert.equal(r2.json.data.idempotentReplay, true);

    const list = await call(base, "GET", "/dispense/orders");
    assert.equal(list.json.data.length, 1);

    const id = r1.json.data.id;
    const v1 = await call(base, "POST", `/dispense/orders/${id}/validate`);
    const v2 = await call(base, "POST", `/dispense/orders/${id}/validate`);
    assert.equal(v1.status, 200);
    assert.equal(v2.json.data.idempotentReplay, true);
  } finally {
    server.close();
  }
});

test("HTTP: 未校验直接 mix 返回 409；非法 JSON 返回 400；不存在路由 404", async () => {
  const { base, server } = await startServer();
  try {
    const created = await call(base, "POST", "/dispense/orders", {
      formulaId: "F1", targetAmount: 10, targetUnit: "g", graduation: 1
    });
    const id = created.json.data.id;
    assert.equal((await call(base, "POST", `/dispense/orders/${id}/mix`)).status, 409);

    const res = await fetch(base + "/dispense/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not-json"
    });
    assert.equal(res.status, 400);

    assert.equal((await call(base, "GET", "/nope")).status, 404);
  } finally {
    server.close();
  }
});

test("HTTP: 目标量未对齐分度 → 422；缺字段 → 400", async () => {
  const { base, server } = await startServer();
  try {
    const bad = await call(base, "POST", "/dispense/preview", {
      formulaId: "F1", targetAmount: 10.05, targetUnit: "g", graduation: 0.1
    });
    assert.equal(bad.status, 422);

    const missing = await call(base, "POST", "/dispense/orders", { formulaId: "F1" });
    assert.equal(missing.status, 400);
  } finally {
    server.close();
  }
});

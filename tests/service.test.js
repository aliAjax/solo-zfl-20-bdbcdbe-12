const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const { makeService, fakeClock } = require("./helpers");
const { HttpError } = require("../src/errors");

/**
 * 自造一个干净的最小数据集，避免依赖种子具体数值。
 * 组分：X（无间隔）、Y（间隔 72h）、Z（无间隔）
 * 禁配：X-Z 直连，Z-W 边用于间接禁配演示
 */
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
      { id: "Y", name: "试剂Y", recordUnit: "g", density: 2, intervalHours: 72, createdAt: now },
      { id: "Z", name: "试剂Z", recordUnit: "mL", density: 1, intervalHours: 0, createdAt: now },
      { id: "W", name: "试剂W", recordUnit: "g", density: 1, intervalHours: 0, createdAt: now }
    ],
    incompatRules: [
      { id: "r1", a: "X", b: "Z", reason: "直连禁配", createdAt: now },
      { id: "r2", a: "Z", b: "W", reason: "传递边", createdAt: now }
    ],
    formulas: [
      {
        id: "F1",
        name: "配方一",
        description: "",
        createdAt: now,
        versions: [
          {
            version: "1.0.0",
            status: "active",
            note: "",
            components: [
              { reagentId: "X", kind: "percent", amount: 50 },
              { reagentId: "Y", kind: "percent", amount: 50 }
            ],
            createdAt: now,
            activatedAt: now
          },
          {
            version: "2.0.0",
            status: "draft",
            note: "",
            components: [
              { reagentId: "X", kind: "percent", amount: 40 },
              { reagentId: "Y", kind: "percent", amount: 60 }
            ],
            createdAt: now,
            activatedAt: null
          }
        ]
      },
      {
        id: "F2",
        name: "配方二",
        description: "只含X",
        createdAt: now,
        versions: [
          {
            version: "1.0.0",
            status: "active",
            note: "",
            components: [{ reagentId: "X", kind: "percent", amount: 100 }],
            createdAt: now,
            activatedAt: now
          }
        ]
      }
    ],
    dispensingOrders: [],
    usages: [],
    clientTokens: {}
  });
}

async function freshService() {
  const { service, store, clock, file } = makeService(undefined, fakeClock("2026-03-01T00:00:00.000Z"));
  // 先 ensure 出文件，再整体替换成自造数据
  const db = await store.read();
  buildDataset(db, clock());
  await store.atomicWrite(db);
  return { service, store, clock, file };
}

async function placeAndMix(service, overrides = {}) {
  const order = await service.createOrder({
    formulaId: "F1",
    targetAmount: 100,
    targetUnit: "g",
    graduation: 1,
    ...overrides
  });
  await service.validateOrder(order.id);
  await service.mixOrder(order.id);
  return order.id;
}

async function rejectWith(fn, status) {
  try {
    await fn();
  } catch (e) {
    assert.ok(e instanceof HttpError, `期望 HttpError，实际 ${e.constructor.name}: ${e.message}`);
    if (status) assert.equal(e.status, status, `期望状态码 ${status}，实际 ${e.status}：${e.message}`);
    return e;
  }
  throw new Error("期望抛错但没有抛");
}

// ---------------- 正常闭环与快照 ----------------

test("完整闭环：草稿→校验(带快照)→调配→使用，用量守恒", async () => {
  const { service } = await freshService();
  const order = await service.createOrder({ formulaId: "F1", targetAmount: 100, targetUnit: "g", graduation: 1 });
  assert.equal(order.status, "draft");
  assert.equal(order.formulaVersion, "1.0.0");
  assert.equal(order.componentsSnapshot, null);

  const validated = await service.validateOrder(order.id);
  assert.equal(validated.status, "validated");
  assert.ok(validated.validatedAt);
  assert.deepEqual(validated.componentsSnapshot.map((i) => i.amount), [50, 50]);
  // 记录单位换算：Y 记录单位 g 与目标一致；密度体现在 canonical/record 上
  assert.equal(validated.totals.sum, 100);

  const mixed = await service.mixOrder(order.id);
  assert.equal(mixed.status, "mixed");
  assert.ok(mixed.mixedAt);

  const { usage } = await service.useOrder(order.id, { damageId: "dmg_1" });
  assert.equal(usage.items.length, 2);
  assert.deepEqual(usage.items[0].splits, [{ damageId: "dmg_1", amount: 50 }]);
  const after = await service.getOrderDetail(order.id);
  assert.equal(after.status, "used");
});

// ---------------- 禁配（直接 / 间接） ----------------

test("直接禁配：含 X+Z 的单子校验时整单 422", async () => {
  const { service } = await freshService();
  await service.addVersion("F2", {
    version: "2.0.0",
    components: [
      { reagentId: "X", kind: "percent", amount: 50 },
      { reagentId: "Z", kind: "percent", amount: 50 }
    ]
  });
  await service.activateVersion("F2", "2.0.0");
  const order = await service.createOrder({ formulaId: "F2", targetAmount: 10, targetUnit: "g", graduation: 1 });
  const e = await rejectWith(() => service.validateOrder(order.id), 422);
  assert.ok(e.details.violations.some((v) => v.direct));
  const fresh = await service.getOrderDetail(order.id);
  assert.equal(fresh.status, "draft"); // 未被推进
  assert.equal(fresh.componentsSnapshot, null); // 未落任何快照
});

test("间接禁配：X 与 W 经 Z 连通，整单拒绝并返回路径", async () => {
  const { service } = await freshService();
  // F2 只有 X；新增含 X+W 的版本（无直连边，但 X-Z-W 连通）
  await service.addVersion("F2", {
    version: "3.0.0",
    components: [
      { reagentId: "X", kind: "percent", amount: 50 },
      { reagentId: "W", kind: "percent", amount: 50 }
    ]
  });
  await service.activateVersion("F2", "3.0.0");
  const order = await service.createOrder({ formulaId: "F2", targetAmount: 10, targetUnit: "g", graduation: 1 });
  const e = await rejectWith(() => service.validateOrder(order.id), 422);
  const v = e.details.violations[0];
  assert.equal(v.direct, false);
  assert.deepEqual(v.path, ["X", "Z", "W"]);
});

// ---------------- 间隔期 ----------------

test("间隔期：Y 距上次成功调配不足72h，再次调配被 422；过后放行", async () => {
  const { service, clock } = await freshService();
  const first = await placeAndMix(service); // 第一次成功调配，含 Y
  await service.useOrder(first, { damageId: "dmg_1" }); // 使用后释放占用，只留间隔闸门
  clock.advanceHours(48);

  const order2 = await service.createOrder({ formulaId: "F1", targetAmount: 10, targetUnit: "g", graduation: 1 });
  const e = await rejectWith(() => service.validateOrder(order2.id), 422);
  const block = e.details.intervalBlocks.find((b) => b.reagentId === "Y");
  assert.ok(block);
  assert.equal(block.remainingHours, 24);
  // 停留在草稿
  assert.equal((await service.getOrderDetail(order2.id)).status, "draft");

  clock.advanceHours(24); // 满 72h
  await service.validateOrder(order2.id);
  clock.advanceHours(1);
  const mixed = await service.mixOrder(order2.id);
  assert.equal(mixed.status, "mixed");
});

test("间隔期以「成功调配(mixed)」为准：已校验但未调配不计时；废弃单不计时", async () => {
  const { service, clock } = await freshService();
  // 一张只校验、后废弃的单子
  const o = await service.createOrder({ formulaId: "F1", targetAmount: 10, targetUnit: "g", graduation: 1 });
  await service.validateOrder(o.id);
  await service.discardOrder(o.id);
  clock.advanceHours(1);
  // 不应构成间隔阻碍（没有任何 mixed 记录）
  const o2 = await service.createOrder({ formulaId: "F1", targetAmount: 10, targetUnit: "g", graduation: 1 });
  const v = await service.validateOrder(o2.id);
  assert.equal(v.status, "validated");
});

test("间隔期在 mix 时刻复校：校验通过后时钟回拨到间隔期内，mix 被拒", async () => {
  const { service, clock } = await freshService();
  // 第一张走完全程（used），释放占用
  const first = await placeAndMix(service);
  await service.useOrder(first, { damageId: "dmg_1" });

  // 72h 后建单并校验通过（间隔刚好满足）
  const late = await service.createOrder({ formulaId: "F1", targetAmount: 10, targetUnit: "g", graduation: 1 });
  clock.set("2026-03-04T00:00:00.000Z"); // 距上次 mixed 恰好 72h
  await service.validateOrder(late.id);

  // 调配时刻回拨到 60h（模拟更严格的复校环境），mix 闸门拒绝
  clock.set("2026-03-03T12:00:00.000Z");
  await rejectWith(() => service.mixOrder(late.id), 422);
  // 单子停留在 validated，未变成 mixed
  assert.equal((await service.getOrderDetail(late.id)).status, "validated");
});

// ---------------- 并发占用 ----------------

test("同一药剂同时刻只归一张调配单：并发两张单，一成功一 409", async () => {
  const { service } = await freshService();
  const a = await service.createOrder({ formulaId: "F2", targetAmount: 10, targetUnit: "g", graduation: 1 });
  const b = await service.createOrder({ formulaId: "F2", targetAmount: 10, targetUnit: "g", graduation: 1 });
  // 同时发起校验
  const results = await Promise.allSettled([service.validateOrder(a.id), service.validateOrder(b.id)]);
  const statuses = results.map((r) => (r.status === "fulfilled" ? "ok" : r.reason.status));
  assert.deepEqual(statuses.sort(), [409, "ok"].sort());
  // 最终只有一张处于 validated
  const validating = await service.listOrders({ status: "validated" });
  assert.equal(validating.length, 1);
  // 败者保持草稿，无快照
  const loser = results.findIndex((r) => r.status === "rejected");
  const loserId = [a.id, b.id][loser];
  const loserOrder = await service.getOrderDetail(loserId);
  assert.equal(loserOrder.status, "draft");
  assert.equal(loserOrder.componentsSnapshot, null);
});

test("使用/废弃后释放占用，另一张单可继续", async () => {
  const { service } = await freshService();
  const a = await service.createOrder({ formulaId: "F2", targetAmount: 10, targetUnit: "g", graduation: 1 });
  await service.validateOrder(a.id);
  await service.mixOrder(a.id);
  await service.useOrder(a.id, { damageId: "dmg_1" }); // used 释放
  const b = await service.createOrder({ formulaId: "F2", targetAmount: 10, targetUnit: "g", graduation: 1 });
  const v = await service.validateOrder(b.id);
  assert.equal(v.status, "validated");
});

// ---------------- 回滚 ----------------

test("任一校验失败整单不落库：禁配单后库内无 validated、无快照、无用量", async () => {
  const { service, store } = await freshService();
  const before = await store.read();
  const beforeCount = before.dispensingOrders.length;
  await service.addVersion("F2", {
    version: "9.0.0",
    components: [
      { reagentId: "X", kind: "percent", amount: 50 },
      { reagentId: "Z", kind: "percent", amount: 50 }
    ]
  });
  await service.activateVersion("F2", "9.0.0");
  const order = await service.createOrder({ formulaId: "F2", targetAmount: 10, targetUnit: "g", graduation: 1 });
  await rejectWith(() => service.validateOrder(order.id), 422);
  const after = await store.read();
  assert.equal(after.dispensingOrders.length, beforeCount + 1); // 草稿在，但
  const saved = after.dispensingOrders.find((o) => o.id === order.id);
  assert.equal(saved.status, "draft");
  assert.equal(saved.componentsSnapshot, null);
  assert.equal(after.usages.length, 0);
  // 禁配规则之外的其它数据未被污染
  assert.ok(after.formulas.find((f) => f.id === "F2"));
});

test("use 时缺损项不存在：整单回滚，单不进入 used、不产生 usage", async () => {
  const { service, store } = await freshService();
  const id = await placeAndMix(service);
  await rejectWith(() => service.useOrder(id, { damageId: "dmg_missing" }), 400);
  const after = await store.read();
  assert.equal(after.dispensingOrders.find((o) => o.id === id).status, "mixed");
  assert.equal(after.usages.length, 0);
});

test("createOrder 引用不存在的配方版本：不落库", async () => {
  const { service, store } = await freshService();
  const before = (await store.read()).dispensingOrders.length;
  await rejectWith(
    () => service.createOrder({ formulaId: "F1", version: "9.9.9", targetAmount: 10, targetUnit: "g", graduation: 1 }),
    404
  );
  assert.equal((await store.read()).dispensingOrders.length, before);
});

// ---------------- 幂等与状态机 ----------------

test("重复提交只生效一次：validate/mix/use/discard 重放", async () => {
  const { service } = await freshService();
  const id = await service.createOrder({
    formulaId: "F1", targetAmount: 10, targetUnit: "g", graduation: 1, clientToken: "tok-1"
  }).then((o) => o.id);

  // 同 clientToken 建单 -> 回放上一张
  const replay = await service.createOrder({
    formulaId: "F1", targetAmount: 10, targetUnit: "g", graduation: 1, clientToken: "tok-1"
  });
  assert.equal(replay.id, id);
  assert.equal(replay.idempotentReplay, true);

  await service.validateOrder(id);
  const v2 = await service.validateOrder(id);
  assert.equal(v2.idempotentReplay, true);
  assert.equal(v2.status, "validated");

  await service.mixOrder(id);
  const m2 = await service.mixOrder(id);
  assert.equal(m2.idempotentReplay, true);

  const u1 = await service.useOrder(id, { damageId: "dmg_1" });
  const u2 = await service.useOrder(id, { damageId: "dmg_1" });
  assert.equal(u2.idempotentReplay, true);
  assert.equal(u2.usage.id, u1.usage.id);

  const { store } = { store: service.store };
  const db = await service.store.read();
  assert.equal(db.usages.length, 1); // 没有重复使用记录
});

test("非法流转拒绝：未校验不能 mix；used 不能 discard；draft 不能 discard", async () => {
  const { service } = await freshService();
  const draft = await service.createOrder({ formulaId: "F1", targetAmount: 10, targetUnit: "g", graduation: 1 });
  await rejectWith(() => service.mixOrder(draft.id), 409);
  await rejectWith(() => service.discardOrder(draft.id), 409);

  const id = await placeAndMix(service);
  await service.useOrder(id, { damageId: "dmg_1" });
  await rejectWith(() => service.discardOrder(id), 409);
});

// ---------------- 配方版本 ----------------

test("新增版本默认 draft，激活后旧 active 转 deprecated，下单钉住新版本", async () => {
  const { service } = await freshService();
  await service.addVersion("F1", {
    version: "3.0.0",
    components: [
      { reagentId: "X", kind: "percent", amount: 30 },
      { reagentId: "Y", kind: "percent", amount: 70 }
    ]
  });
  await service.activateVersion("F1", "3.0.0");
  const db = await service.store.read();
  const f1 = db.formulas.find((f) => f.id === "F1");
  assert.equal(f1.versions.find((v) => v.version === "3.0.0").status, "active");
  assert.equal(f1.versions.find((v) => v.version === "1.0.0").status, "deprecated");

  const order = await service.createOrder({ formulaId: "F1", targetAmount: 100, targetUnit: "g", graduation: 1 });
  assert.equal(order.formulaVersion, "3.0.0");
});

test("重复版本号冲突 409；组分引用不存在药剂 404 且不写版本", async () => {
  const { service } = await freshService();
  await rejectWith(
    () => service.addVersion("F1", {
      version: "1.0.0",
      components: [{ reagentId: "X", kind: "percent", amount: 100 }]
    }),
    409
  );
  const before = (await service.store.read()).formulas.find((f) => f.id === "F1").versions.length;
  await rejectWith(
    () => service.addVersion("F1", {
      version: "4.0.0",
      components: [{ reagentId: "GHOST", kind: "percent", amount: 100 }]
    }),
    404
  );
  const after = (await service.store.read()).formulas.find((f) => f.id === "F1").versions.length;
  assert.equal(after, before);
});

// ---------------- 使用分摊与追溯 ----------------

test("多缺损项按 factor 分摊，largest-remainder 守恒；可按缺损项与版本追溯", async () => {
  const { service } = await freshService();
  // F2 为 100% X：101g 按 1:2 分摊 -> 34 / 67（最大余数法补 1 给余数大者）
  const order = await service.createOrder({ formulaId: "F2", targetAmount: 101, targetUnit: "g", graduation: 1 });
  await service.validateOrder(order.id);
  await service.mixOrder(order.id);
  const { usage } = await service.useOrder(order.id, {
    allocations: [
      { damageId: "dmg_1", factor: 1 },
      { damageId: "dmg_2", factor: 2 }
    ]
  });
  const x = usage.items.find((i) => i.reagentId === "X");
  assert.deepEqual(x.splits, [
    { damageId: "dmg_1", amount: 34 },
    { damageId: "dmg_2", amount: 67 }
  ]);
  for (const item of usage.items) {
    const sum = item.splits.reduce((s, s2) => s + s2.amount, 0);
    assert.equal(sum, 101, `${item.reagentId} 分摊之和应等于调配量`);
  }

  const trace1 = await service.trace({ damageId: "dmg_1" });
  assert.equal(trace1.rows.length, 1); // 只有 X
  assert.equal(trace1.rows[0].amount, 34);
  assert.equal(trace1.rows[0].factorShare, 0.333333);
  assert.ok(Math.abs(trace1.rows[0].factorShare - 1 / 3) < 1e-5);

  const traceVer = await service.trace({ formulaVersion: "1.0.0" });
  assert.ok(traceVer.rows.length >= 1);
  assert.ok(traceVer.rows.every((r) => r.formulaVersion === "1.0.0"));

  const traceReagent = await service.trace({ reagentId: "X" });
  assert.ok(traceReagent.rows.every((r) => r.reagentId === "X"));
  assert.ok(traceReagent.rows[0].recordAmount > 0);
});

test("追溯空结果返回空数组", async () => {
  const { service } = await freshService();
  const trace = await service.trace({ damageId: "dmg_1" });
  assert.deepEqual(trace.rows, []);
});

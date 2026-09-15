const test = require("node:test");
const assert = require("node:assert/strict");
const { computeMix, validateComponents } = require("../src/dispense");

const reagents = {
  A: { density: 0.58, recordUnit: "g" },
  B: { density: 1, recordUnit: "mL" },
  C: { density: 1.72, recordUnit: "g" }
};

test("三等份 100g / 分度1：largest-remainder 得 34/33/33，总和守恒", () => {
  const mix = computeMix({
    components: [
      { reagentId: "A", kind: "percent", amount: 100 / 3 },
      { reagentId: "B", kind: "percent", amount: 100 / 3 },
      { reagentId: "C", kind: "percent", amount: 100 / 3 }
    ],
    targetAmount: 100,
    targetUnit: "g",
    graduation: 1,
    reagents
  });
  assert.deepEqual(mix.items.map((i) => i.amount), [34, 33, 33]);
  assert.equal(mix.totals.sum, 100);
  assert.equal(mix.totals.diff, 0);
});

test("三等份 10g / 分度0.1：3.4/3.3/3.3，总和严格守恒", () => {
  const mix = computeMix({
    components: [
      { reagentId: "A", kind: "percent", amount: 100 / 3 },
      { reagentId: "B", kind: "percent", amount: 100 / 3 },
      { reagentId: "C", kind: "percent", amount: 100 / 3 }
    ],
    targetAmount: 10,
    targetUnit: "g",
    graduation: 0.1,
    reagents
  });
  assert.deepEqual(mix.items.map((i) => i.amount), [3.4, 3.3, 3.3]);
  assert.equal(mix.totals.sum, 10);
});

test("目标未对齐分度直接拒绝", () => {
  assert.throws(
    () =>
      computeMix({
        components: [{ reagentId: "A", kind: "percent", amount: 100 }],
        targetAmount: 10.05,
        targetUnit: "g",
        graduation: 0.1,
        reagents
      }),
    /未对齐最小分度/
  );
});

test("质量份配方按体积目标下单：经密度折算后守恒（mL）", () => {
  const mix = computeMix({
    components: [
      { reagentId: "A", kind: "mass", amount: 1, unit: "g" },
      { reagentId: "B", kind: "mass", amount: 6, unit: "g" }
    ],
    targetAmount: 700,
    targetUnit: "mL",
    graduation: 1,
    reagents
  });
  assert.equal(mix.totals.sum, 700);
  for (const item of mix.items) assert.equal(Number.isInteger(item.amount), true);
  // B（水，记录单位 mL）的记录量就是其体积量
  const b = mix.items.find((i) => i.reagentId === "B");
  assert.ok(Math.abs(b.record.amount - b.amount) < 1e-6);
});

test("体积份按质量目标：V·ρ 折质量份", () => {
  const mix = computeMix({
    components: [
      { reagentId: "A", kind: "volume", amount: 100, unit: "mL" },
      { reagentId: "B", kind: "volume", amount: 100, unit: "mL" }
    ],
    targetAmount: 158,
    targetUnit: "g",
    graduation: 1,
    reagents
  });
  assert.equal(mix.totals.sum, 158);
  // A 密度 0.58 份 58，B 密度 1 份 100，A 应少于 B
  const a = mix.items.find((i) => i.reagentId === "A").amount;
  const b = mix.items.find((i) => i.reagentId === "B").amount;
  assert.ok(a < b);
  assert.deepEqual([a, b], [58, 100]);
});

test("跨量纲组分缺密度时抛错", () => {
  assert.throws(
    () =>
      computeMix({
        components: [{ reagentId: "A", kind: "volume", amount: 1, unit: "mL" }],
        targetAmount: 10,
        targetUnit: "g",
        graduation: 1,
        reagents: { A: {} }
      }),
    /需要密度/
  );
});

test("每条结果都带记录单位与标准单位（g/mL）两套量", () => {
  const mix = computeMix({
    components: [{ reagentId: "B", kind: "percent", amount: 100 }],
    targetAmount: 500,
    targetUnit: "mL",
    graduation: 10,
    reagents
  });
  const item = mix.items[0];
  assert.equal(item.amount, 500);
  assert.equal(item.record.unit, "mL");
  assert.equal(item.canonical.unit, "mL");
});

test("纯百分比配方比例和不等于100报错", () => {
  const errors = validateComponents([
    { reagentId: "A", kind: "percent", amount: 60 },
    { reagentId: "B", kind: "percent", amount: 30 }
  ]);
  assert.ok(errors.some((e) => e.includes("之和必须为100")));
});

test("重复组分 / 非法 kind / 百分比越界报错", () => {
  assert.ok(
    validateComponents([
      { reagentId: "A", kind: "percent", amount: 50 },
      { reagentId: "A", kind: "percent", amount: 50 }
    ]).some((e) => e.includes("重复"))
  );
  assert.ok(validateComponents([{ reagentId: "A", kind: "mole", amount: 1 }]).some((e) => e.includes("kind")));
  assert.ok(validateComponents([{ reagentId: "A", kind: "percent", amount: 120 }]).length > 0);
  assert.deepEqual(validateComponents([]), ["配方至少包含一个组分"]);
});

test("混份制（质量份+体积份+百分比）可以换算且守恒", () => {
  const mix = computeMix({
    components: [
      { reagentId: "A", kind: "mass", amount: 10, unit: "g" },
      { reagentId: "B", kind: "volume", amount: 50, unit: "mL" },
      { reagentId: "C", kind: "percent", amount: 20 }
    ],
    targetAmount: 200,
    targetUnit: "g",
    graduation: 0.5,
    reagents
  });
  assert.equal(mix.totals.sum, 200);
  assert.equal(mix.totals.sum % 0.5, 0);
});

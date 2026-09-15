const test = require("node:test");
const assert = require("node:assert/strict");
const {
  convert,
  dimensionOf,
  decimalsFromGraduation,
  roundTo,
  isAligned
} = require("../src/units");

test("同量纲换算：kg -> g -> mg", () => {
  assert.equal(convert(1, "kg", "g"), 1000);
  assert.equal(convert(1, "kg", "mg"), 1_000_000);
  assert.equal(convert(500, "mL", "L"), 0.5);
});

test("单位写法大小写不敏感（mL/ml/ML）", () => {
  assert.equal(dimensionOf("ML"), "mL");
  assert.equal(convert(1, "L", "mL"), 1000);
});

test("跨量纲经密度换算且可逆：mass = V·ρ", () => {
  assert.equal(convert(100, "mL", "g", 0.789), 78.9);
  assert.ok(Math.abs(convert(78.9, "g", "mL", 0.789) - 100) < 1e-9);
  assert.equal(convert(100, "g", "mL", 1), 100);
});

test("跨量纲缺密度抛错", () => {
  assert.throws(() => convert(10, "g", "mL"), /密度/);
});

test("非法单位抛错", () => {
  assert.equal(dimensionOf("斤"), null);
  assert.throws(() => convert(1, "斤", "g"), /不支持的单位/);
});

test("分度小数位只接受 1/2/5 十进制分度", () => {
  assert.equal(decimalsFromGraduation(1), 0);
  assert.equal(decimalsFromGraduation(0.5), 1);
  assert.equal(decimalsFromGraduation(0.02), 2);
  assert.equal(decimalsFromGraduation(100), 0);
  assert.throws(() => decimalsFromGraduation(0.3), /1\/2\/5/);
});

test("对齐判断", () => {
  assert.equal(isAligned(10.0, 0.1), true);
  assert.equal(isAligned(10.05, 0.1), false);
  assert.equal(isAligned(3, 1), true);
});

test("roundTo 抹浮点尾差", () => {
  assert.equal(roundTo(1.005, 2), 1.01);
  assert.equal(roundTo(7.0000000001, 1), 7);
});

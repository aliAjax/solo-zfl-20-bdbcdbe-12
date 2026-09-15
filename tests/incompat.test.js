const test = require("node:test");
const assert = require("node:assert/strict");
const { buildGraph, findPath, checkIncompatibility } = require("../src/incompat");

const rules = [
  { a: "oxalic", b: "starch", reason: "r1" },
  { a: "starch", b: "ethanol", reason: "r2" }
];

test("直接禁配：一条边即命中，direct=true", () => {
  const v = checkIncompatibility(["oxalic", "starch"], rules);
  assert.equal(v.length, 1);
  assert.equal(v[0].direct, true);
  assert.deepEqual(v[0].path, ["oxalic", "starch"]);
});

test("间接禁配：经第三种药剂传递，direct=false 且给出路径", () => {
  const v = checkIncompatibility(["oxalic", "ethanol"], rules);
  assert.equal(v.length, 1);
  assert.equal(v[0].direct, false);
  assert.deepEqual(v[0].path, ["oxalic", "starch", "ethanol"]);
  assert.equal(v[0].rules.length, 2);
});

test("长链间接禁配 A-B-C-D：A 与 D 连通即拒绝", () => {
  const chain = [
    { a: "A", b: "B" },
    { a: "B", b: "C" },
    { a: "C", b: "D" }
  ];
  const graph = buildGraph(chain);
  assert.deepEqual(findPath(graph, "A", "D"), ["A", "B", "C", "D"]);
  const v = checkIncompatibility(["A", "D"], chain);
  assert.equal(v[0].direct, false);
});

test("不相容图不连通则放行", () => {
  const v = checkIncompatibility(["oxalic", "alum"], rules);
  assert.deepEqual(v, []);
});

test("单一组分 / 无规则 不误判", () => {
  assert.deepEqual(checkIncompatibility(["oxalic"], rules), []);
  assert.deepEqual(checkIncompatibility(["oxalic", "ethanol"], []), []);
});

test("三种药剂同单：两两违规全部列出", () => {
  const v = checkIncompatibility(["oxalic", "starch", "ethanol"], rules);
  // 直连 oxalic-starch、starch-ethanol，间接 oxalic-ethanol
  assert.equal(v.length, 3);
  assert.ok(v.some((x) => x.direct));
  assert.ok(v.some((x) => !x.direct));
});

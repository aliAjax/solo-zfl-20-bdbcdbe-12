/**
 * 禁配规则（纯函数）。
 *
 * rules: [{ a: reagentId, b: reagentId, reason? }]  无向边
 *   - 直接禁配：同一配方/调配单同时包含边两端的药剂。
 *   - 间接禁配：在全局禁配图上两点同属一个连通分量（可经由第三种药剂传递）。
 *     例：A-B、B-C 有禁配，则 {A,C} 为间接禁配，整单拒绝。
 */

function buildGraph(rules) {
  const graph = new Map();
  const addEdge = (x, y) => {
    if (!graph.has(x)) graph.set(x, new Set());
    graph.get(x).add(y);
  };
  for (const rule of rules || []) {
    if (!rule || !rule.a || !rule.b || rule.a === rule.b) continue;
    addEdge(rule.a, rule.b);
    addEdge(rule.b, rule.a);
  }
  return graph;
}

/**
 * BFS：返回 start 到 target 的一条路径（含两端），不可达返回 null。
 * 长度 2（两节点一边）即直接禁配；更长即间接禁配。
 */
function findPath(graph, start, target) {
  if (!graph.has(start) || start === target) return null;
  const queue = [start];
  const prev = new Map([[start, null]]);
  while (queue.length) {
    const node = queue.shift();
    for (const next of graph.get(node) || []) {
      if (prev.has(next)) continue;
      prev.set(next, node);
      if (next === target) {
        const path = [next];
        let cur = node;
        while (cur !== null) {
          path.push(cur);
          cur = prev.get(cur);
        }
        return path.reverse();
      }
      queue.push(next);
    }
  }
  return null;
}

/**
 * 检查一组药剂是否存在禁配（含间接）。
 * reagentIds: 去重后的药剂 id 列表。
 * 返回违规列表：[{ a, b, direct, path, rules }]，空数组表示全部相容。
 */
function checkIncompatibility(reagentIds, rules) {
  const graph = buildGraph(rules);
  const ids = Array.from(new Set(reagentIds));
  const violations = [];
  const seenPair = new Set();
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const path = findPath(graph, ids[i], ids[j]);
      if (!path) continue;
      const pair = [ids[i], ids[j]].sort().join("");
      if (seenPair.has(pair)) continue;
      seenPair.add(pair);
      // 沿路径收集命中的规则说明
      const hitRules = [];
      for (let k = 0; k < path.length - 1; k++) {
        const x = path[k];
        const y = path[k + 1];
        const rule = (rules || []).find(
          (r) => r && ((r.a === x && r.b === y) || (r.a === y && r.b === x))
        );
        if (rule) hitRules.push({ a: x, b: y, reason: rule.reason || "" });
      }
      violations.push({
        a: ids[i],
        b: ids[j],
        direct: path.length === 2,
        path,
        rules: hitRules
      });
    }
  }
  return violations;
}

module.exports = { buildGraph, findPath, checkIncompatibility };

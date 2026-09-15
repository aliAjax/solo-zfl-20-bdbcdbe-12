# 接口文档

基础地址：`http://127.0.0.1:3020`
所有请求/响应均为 `application/json; charset=utf-8`。

## 约定

- 成功返回 `{ "data": ... }`；失败返回 `{ "error": "..." }`，校验类失败附 `{ "details": ... }`。
- 状态码：`200` 成功 / `201` 已创建 / `400` 请求格式或字段错误 / `404` 资源不存在 / `409` 状态冲突（并发占用、非法流转）/ `422` 业务校验失败（禁配、间隔、换算）。
- 时间均为 ISO-8601 UTC。
- 单位：质量 `mg/g/kg`，体积 `mL/L`（大小写不敏感）。密度单位 g/mL。
- 最小分度 `graduation`：必须为 1/2/5 十进制分度（1, 0.5, 0.1, 0.02, 10, 100…）。

## 数据模型

### Reagent 药剂
```json
{
  "id": "reagent_xxx",
  "name": "明矾",
  "recordUnit": "g",          // 记账单位
  "density": 1.72,            // g/mL，跨量纲换算必需
  "intervalHours": 72,        // 距上次成功调配的最小间隔，0 表示不限制
  "note": "",
  "createdAt": "..."
}
```

### Formula 配方与版本
```json
{
  "id": "formula_xxx",
  "name": "淀粉糨糊",
  "description": "",
  "createdAt": "...",
  "versions": [
    {
      "version": "1.1.0",
      "status": "active",     // draft | active | deprecated
      "note": "",
      "components": [
        { "reagentId": "reagent_a", "kind": "mass",    "amount": 1, "unit": "g" },
        { "reagentId": "reagent_b", "kind": "volume",  "amount": 50, "unit": "mL" },
        { "reagentId": "reagent_c", "kind": "percent", "amount": 14 }
      ],
      "createdAt": "...",
      "activatedAt": "..."
    }
  ]
}
```

### DispensingOrder 调配单
```json
{
  "id": "disp_xxx",
  "formulaId": "formula_xxx",
  "formulaName": "淀粉糨糊",
  "formulaVersion": "1.1.0",  // 创建时钉住
  "targetAmount": 100,
  "targetUnit": "g",
  "graduation": 0.1,
  "status": "draft",          // draft|validated|mixed|used|discarded
  "componentsSnapshot": null, // 校验通过后写入各组分用量
  "totals": null,
  "damageId": null,
  "createdAt": "...", "validatedAt": null, "mixedAt": null,
  "usedAt": null, "discardedAt": null
}
```
`componentsSnapshot[]` 元素：
```json
{
  "reagentId": "reagent_b",
  "unit": "g",                // 下单单位
  "amount": 84,               // 已按分度取整
  "exactAmount": 84.000000001,
  "record":   { "amount": 84, "unit": "mL" },  // 药剂记账单位量
  "canonical":{ "amount": 84, "unit": "g" }    // 标准单位（g 或 mL）
}
```

---

## 药剂

### GET /reagents
返回全部药剂。

### POST /reagents
请求：
```json
{ "name": "明矾", "recordUnit": "g", "density": 1.72, "intervalHours": 72, "note": "" }
```
必填 `name/recordUnit/density`。名称重复 → 409。

## 禁配规则

### GET /incompat-rules
### POST /incompat-rules
```json
{ "a": "reagent_oxalic", "b": "reagent_wheat_starch", "reason": "..." }
```
无向边；重复规则 → 409。禁配判定含传递闭包（间接禁配）。

## 配方

### GET /formulas
### GET /formulas/:id
### POST /formulas
```json
{ "name": "淀粉糨糊", "description": "", "version": { ...首个版本，可选... } }
```
带 `version` 时直接创建并激活。

### POST /formulas/:id/versions
新增版本，默认 `draft`。
```json
{
  "version": "1.2.0",
  "note": "",
  "components": [ { "reagentId": "reagent_a", "kind": "percent", "amount": 100 } ]
}
```
校验：组分非空、不重复、比例合法、纯百分比合计 100、组分药剂存在。失败 → 400/404，且不写入版本。

### POST /formulas/:id/versions/:version/activate
激活指定版本，同配方其它版本置为 `deprecated`。

## 换算预览

### POST /dispense/preview
不落库，按下单参数试算各组分用量。
```json
{ "formulaId": "formula_starch_paste", "version": "1.1.0",
  "targetAmount": 100, "targetUnit": "g", "graduation": 0.1 }
```
`version` 可省略（取当前 active）。返回结构同校验后快照，含 `items[]` 与 `totals`：
```json
{
  "data": {
    "formulaId": "...", "version": "1.1.0", "targetDim": "g",
    "graduation": 0.1, "decimals": 1,
    "items": [ ... ],
    "totals": { "target": 100, "unit": "g", "sum": 100, "exactSum": 100, "diff": 0 }
  }
}
```

## 调配单

### POST /dispense/orders
创建草稿。
```json
{
  "formulaId": "formula_starch_paste",
  "version": "1.1.0",        // 可省略，取 active
  "targetAmount": 100,
  "targetUnit": "g",
  "graduation": 0.1,
  "damageId": "damage_demo_1", // 可选，预关联缺损项
  "note": "",
  "clientToken": "uuid-xxx"    // 可选，幂等键
}
```
- 目标量未对齐分度、引用不存在的版本等 → 400/404/422，且不落库。
- 同 `clientToken` 重放：返回原单，`idempotentReplay: true`。

### GET /dispense/orders
查询参数：`status`、`formulaId`、`formulaVersion`。

### GET /dispense/orders/:id

### 状态流转（均为 POST，请求体可空 `{}`）

| 动作 | 路径 | 前置状态 | 成功后状态 |
|---|---|---|---|
| 校验 | `/dispense/orders/:id/validate` | draft | validated |
| 调配 | `/dispense/orders/:id/mix` | validated | mixed |
| 使用 | `/dispense/orders/:id/use` | mixed | used |
| 废弃 | `/dispense/orders/:id/discard` | validated/mixed | discarded |

- **validate / mix** 都重跑三道闸门（禁配、间隔、占用），以请求处理时刻为准。
- 重复调用同一动作：幂等重放当前结果，`idempotentReplay: true`，不重复生效。
- 非法流转 → 409。
- 校验失败 → 422（禁配/间隔）或 409（占用），**整单不落库**。

`validate` / `mix` 失败示例（422）：
```json
{
  "error": "校验未通过，整单拒绝",
  "details": {
    "violations": [
      { "a": "reagent_oxalic", "b": "reagent_ethanol",
        "direct": false,
        "path": ["reagent_oxalic", "reagent_wheat_starch", "reagent_ethanol"],
        "rules": [ { "a": "...", "b": "...", "reason": "..." } ] }
    ],
    "intervalBlocks": [
      { "reagentId": "reagent_alum", "reagentName": "明矾",
        "intervalHours": 72, "lastMixedAt": "...", "remainingHours": 24 }
    ]
  }
}
```
占用失败示例（409）：
```json
{ "error": "组分药剂被其它未完结调配单占用",
  "details": { "occupied": [ { "reagentId": "reagent_x", "orderId": "disp_yyy" } ] } }
```

### POST /dispense/orders/:id/use
登记使用去向，二选一：
```json
{ "damageId": "damage_demo_1", "note": "虫蛀孔填补" }
```
```json
{ "allocations": [
    { "damageId": "damage_demo_1", "factor": 1 },
    { "damageId": "damage_demo_2", "factor": 2 }
], "note": "" }
```
多缺损项按 `factor` 比例分摊每种药剂（最大余数法、对齐分度、自检守恒）。缺损项不存在 → 400，整单回滚（单据仍为 mixed，不产生 usage）。
成功返回 `{ "data": { "order": {...}, "usage": {...} } }`。

### POST /dispense/orders/:id/discard
请求体 `{ "reason": "" }`。已使用单据不可废弃（409）。

## 追溯

### GET /trace
查询参数（均可组合）：`damageId`、`reagentId`、`formulaId`、`formulaVersion`。
返回 `{ "usages": [...原始使用记录], "rows": [...展开后的用量行...] }`，每行对应「某次使用 × 某缺损项 × 某药剂」：
```json
{
  "usageId": "usage_xxx", "orderId": "disp_xxx",
  "damageId": "damage_demo_1", "factor": 1, "factorShare": 0.333333,
  "formulaId": "formula_xxx", "formulaVersion": "1.1.0",
  "reagentId": "reagent_alum", "reagentName": "明矾",
  "amount": 0.7, "unit": "g",
  "recordAmount": 0.7, "recordUnit": "g",
  "usedAt": "..."
}
```

## 原有拓片修补接口

行为不变：`GET/POST /rubbings`、`GET/POST /rubbings/:id/damages`、`GET /damages`、`PATCH /damages/:id`、`GET/POST /batches`、`GET /batches/:id`、`POST /batches/:id/complete`。

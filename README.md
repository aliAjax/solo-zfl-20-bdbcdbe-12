# 古籍拓片缺损修补 API（含药剂配方与调配）

纯后端、零依赖的 Node 服务。`data/db.json` 持久化拓片、缺损项、修补批次，以及药剂、禁配规则、配方版本、调配单与使用记录。

- 运行时：Node.js ≥ 20（用到内置 `node:test`、全局 `fetch`）
- 依赖：无

## 启动

```bash
# 默认端口 3020，默认库 ./data/db.json
node server.js

# 自定义
PORT=3020 DB_FILE=/var/lib/rubbishing/db.json node server.js
```

老版本 `db.json` 首次启动会自动迁移：只补齐缺失集合；药剂域集合（reagents / incompatRules / formulas）为空时灌入演示数据，原有拓片与缺损数据原样保留。

## 测试

```bash
npm test            # node --test tests/
# 或
node --test tests/
```

覆盖：单位/密度换算、最小分度取整与总和守恒、直接与间接禁配、间隔期、并发占用、状态机非法流转、幂等重放、整单回滚、按缺损项/配方版本追溯，以及一组真实端口的 HTTP 端到端用例。

## 领域语义（务必先读）

### 药剂
记录 `recordUnit`（记账单位：mg/g/kg/mL/L）与 `density`（g/mL）。跨质量/体积换算一律走密度：`质量 = 体积 × 密度`。

### 配方版本
配方下挂多个版本，同一时刻仅一个 `active`；激活新版本会把旧版本置为 `deprecated`。调配单创建时**钉住**当时的版本号，之后配方改版不影响在途单据。

每个版本的组分比例支持三种写法，可混用：

| kind | 含义 | 字段 |
|---|---|---|
| `mass` | 质量份 | `amount` + `unit`（mg/g/kg） |
| `volume` | 体积份 | `amount` + `unit`（mL/L） |
| `percent` | 百分比份 | `amount`（0,100]；纯百分比配方须合计 100） |

混份归一化：目标是质量时，体积份按 `m = V·ρ` 折质量份、百分比视为质量百分比；目标是体积时反之。凡涉及非目标量纲的组分，该药剂必须登记密度。

### 用量换算、最小分度与总和守恒
下单给 `targetAmount / targetUnit / graduation`（最小分度，须是 1、2、5 开头的十进制分度，如 `1 / 0.5 / 0.1 / 0.02 / 10`）。目标总量必须对齐分度的整数倍，否则拒绝。

各组分先按份额得精确量，再向下取整到分度，最后用**最大余数法**把丢掉的分度逐个补给余数最大的组分——取整后各分量之和**严格等于目标总量**（diff 恒为 0）。每条用量同时给出：下单单位量、药剂记账单位量（`record`）、标准单位量（`canonical`，克或毫升）。

### 三道校验闸门（validate 与 mix 都会跑，以调配时刻为准）
1. **禁配（含间接禁配）**：禁配规则是无向边。同单组分之间有直连边即直接禁配；两点在禁配图上经第三种药剂连通即**间接禁配**（如 A-B、B-C，则 {A,C} 禁配）。命中任一即整单 422，并返回连通路径。
2. **间隔期**：药剂可设 `intervalHours`。距该药剂上一次**成功调配**（单据进入 `mixed` 的时刻）未满间隔期，拒绝并返回剩余小时数。已校验未调配、已废弃的单据不计时。
3. **并发占用**：同一药剂在同一时刻只能归属于一张 `validated`/`mixed` 状态的调配单；并发提交时一进一拒（409）。单据 `used` 或 `discarded` 后释放。

### 调配单状态机
`draft → validated → mixed → used`；`validated/mixed` 可转 `discarded`（`used` 不可废弃）。

- 任何动作重复提交只生效一次（返回体带 `idempotentReplay: true`）。
- 建单可带 `clientToken`，同令牌重复建单返回同一张单。
- **任一校验失败整单不落库**：不写快照、不推进状态、不产生用量。

### 使用与追溯
`mixed → used` 时登记使用去向：单个缺损项（`damageId`）或多个缺损项按 `factor` 比例分摊。分摊同样走最大余数法并自检守恒。之后可用 `GET /trace` 按缺损项、药剂、配方、配方版本追溯逐药剂用量（同时给出下单单位与记账单位两栏）。

## 接口一览

详见 [`docs/api.md`](docs/api.md)。

```
GET  /health
GET  /reagents                 POST /reagents
GET  /incompat-rules           POST /incompat-rules
GET  /formulas                 POST /formulas
GET  /formulas/:id
POST /formulas/:id/versions
POST /formulas/:id/versions/:version/activate
POST /dispense/preview
POST /dispense/orders          GET /dispense/orders[?status=&formulaId=&formulaVersion=]
GET  /dispense/orders/:id
POST /dispense/orders/:id/validate
POST /dispense/orders/:id/mix
POST /dispense/orders/:id/use
POST /dispense/orders/:id/discard
GET  /trace[?damageId=&reagentId=&formulaId=&formulaVersion=]

# 原有拓片修补接口（保持不变）
GET/POST /rubbings            GET/POST /rubbings/:id/damages
GET /damages                  PATCH /damages/:id
GET/POST /batches             GET /batches/:id   POST /batches/:id/complete
```

## 并发与部署说明

进程内用一把异步互斥锁把「读—校验—写」串行化，落盘采用临时文件 + 原子 `rename`。因此单进程内并发安全；**多进程/多实例部署需换用带事务的数据库**，文件锁不跨进程。

## 免责声明

仓库内置的药剂密度、72 小时间隔、禁配规则等均为演示用占位数据，不代表真实化学/药理结论；上线前须由文保专业人员核定。

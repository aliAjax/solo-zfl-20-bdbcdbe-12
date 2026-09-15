/**
 * 药剂配方与调配领域服务。
 *
 * 调配单状态机：draft（草稿）→ validated（校验通过并占用）→ mixed（已调配）
 *   → used（已使用）/ discarded（废弃，可从 validated/mixed 废弃）
 * 每次流转都是幂等动作：重复提交同一动作只生效一次（直接回放上一结果）。
 *
 * 整单事务：每次流转都在 store.mutate 临界区内重新读库，
 * 任一校验失败即抛错且不落库（校验失败的整单不写任何内容）。
 */

const { HttpError } = require("./errors");
const { dimensionOf, convert, roundTo, decimalsFromGraduation } = require("./units");
const { computeMix, validateComponents } = require("./dispense");
const { checkIncompatibility } = require("./incompat");

const ORDER_STATUSES = ["draft", "validated", "mixed", "used", "discarded"];
const VERSION_STATUSES = ["draft", "active", "deprecated"];
const HOUR_MS = 3600_000;

let seq = 0;
function makeId(prefix, clock) {
  seq = (seq + 1) % 1e6;
  const stamp = Buffer.from(clock().replace(/\D/g, "").slice(0, 17)).toString("base64url");
  return `${prefix}_${stamp}_${seq.toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

function isPositiveNumber(v) {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

class Service {
  constructor(store, clock = () => new Date().toISOString()) {
    this.store = store;
    this.clock = clock;
  }

  now() {
    return this.clock();
  }

  // ---------- 读取辅助 ----------

  getReagent(db, id) {
    const reagent = db.reagents.find((r) => r.id === id);
    if (!reagent) throw HttpError.notFound(`药剂不存在：${id}`);
    return reagent;
  }

  getFormula(db, id) {
    const formula = db.formulas.find((f) => f.id === id);
    if (!formula) throw HttpError.notFound(`配方不存在：${id}`);
    return formula;
  }

  getVersion(db, formulaId, version) {
    const formula = this.getFormula(db, formulaId);
    const ver = formula.versions.find((v) => v.version === version);
    if (!ver) throw HttpError.notFound(`配方 ${formulaId} 不存在版本 ${version}`);
    return { formula, version: ver };
  }

  activeVersion(db, formulaId) {
    const formula = this.getFormula(db, formulaId);
    const ver = formula.versions.find((v) => v.status === "active");
    if (!ver) throw HttpError.unprocessable(`配方 ${formula.name} 没有处于 active 的版本`);
    return { formula, version: ver };
  }

  getOrder(db, id, { required = true } = {}) {
    const order = db.dispensingOrders.find((o) => o.id === id);
    if (!order && required) throw HttpError.notFound(`调配单不存在：${id}`);
    return order;
  }

  reagentMap(db, ids) {
    const map = {};
    for (const id of new Set(ids)) map[id] = this.getReagent(db, id);
    return map;
  }

  // ---------- 药剂 ----------

  async listReagents() {
    const db = await this.store.read();
    return db.reagents;
  }

  async createReagent(body) {
    if (!body || !body.name) throw HttpError.badRequest("缺少字段：name");
    if (!isPositiveNumber(body.density)) {
      throw HttpError.badRequest("density 必须为正数（g/mL）");
    }
    if (!body.recordUnit || dimensionOf(body.recordUnit) === null) {
      throw HttpError.badRequest("recordUnit 必须是 mg/g/kg/mL/L 之一");
    }
    if (body.intervalHours !== undefined && (!Number.isFinite(body.intervalHours) || body.intervalHours < 0)) {
      throw HttpError.badRequest("intervalHours 必须为非负数（小时）");
    }
    return this.store.mutate((db) => {
      if (db.reagents.some((r) => r.name === body.name)) {
        throw HttpError.conflict(`药剂名称已存在：${body.name}`);
      }
      const reagent = {
        id: makeId("reagent", this.clock),
        name: body.name,
        recordUnit: body.recordUnit,
        density: body.density,
        intervalHours: body.intervalHours || 0,
        note: body.note || "",
        createdAt: this.now()
      };
      db.reagents.push(reagent);
      return reagent;
    });
  }

  // ---------- 禁配规则 ----------

  async listRules() {
    const db = await this.store.read();
    return db.incompatRules;
  }

  async addRule(body) {
    if (!body || !body.a || !body.b) throw HttpError.badRequest("缺少字段：a, b");
    if (body.a === body.b) throw HttpError.badRequest("禁配规则两端不能是同一种药剂");
    return this.store.mutate((db) => {
      this.getReagent(db, body.a);
      this.getReagent(db, body.b);
      const dup = db.incompatRules.find(
        (r) => (r.a === body.a && r.b === body.b) || (r.a === body.b && r.b === body.a)
      );
      if (dup) throw HttpError.conflict("该禁配规则已存在", { existingId: dup.id });
      const rule = {
        id: makeId("rule", this.clock),
        a: body.a,
        b: body.b,
        reason: body.reason || "",
        createdAt: this.now()
      };
      db.incompatRules.push(rule);
      return rule;
    });
  }

  // ---------- 配方与版本 ----------

  async listFormulas() {
    const db = await this.store.read();
    return db.formulas;
  }

  async getFormulaDetail(formulaId) {
    const db = await this.store.read();
    return this.getFormula(db, formulaId);
  }

  async createFormula(body) {
    if (!body || !body.name) throw HttpError.badRequest("缺少字段：name");
    return this.store.mutate((db) => {
      if (db.formulas.some((f) => f.name === body.name)) {
        throw HttpError.conflict(`配方名称已存在：${body.name}`);
      }
      const formula = {
        id: makeId("formula", this.clock),
        name: body.name,
        description: body.description || "",
        createdAt: this.now(),
        versions: []
      };
      db.formulas.push(formula);
      // 允许创建时直接带第一个版本
      if (body.version) {
        this._addVersion(db, formula, body.version, { activate: true });
      }
      return formula;
    });
  }

  _addVersion(db, formula, verInput, { activate }) {
    if (!verInput || !verInput.version) throw HttpError.badRequest("版本号必填（version）");
    if (formula.versions.some((v) => v.version === verInput.version)) {
      throw HttpError.conflict(`配方 ${formula.name} 已有版本 ${verInput.version}`);
    }
    const componentErrors = validateComponents(verInput.components || []);
    if (componentErrors.length) throw HttpError.badRequest(componentErrors.join("；"), { componentErrors });
    // 组分必须都存在
    for (const comp of verInput.components) this.getReagent(db, comp.reagentId);
    const status = activate ? "active" : verInput.status === "deprecated" ? "deprecated" : "draft";
    const ver = {
      version: verInput.version,
      status,
      note: verInput.note || "",
      components: verInput.components.map((c) => ({ ...c })),
      createdAt: this.now(),
      activatedAt: activate ? this.now() : null
    };
    if (activate) {
      for (const v of formula.versions) v.status = "deprecated";
    }
    formula.versions.push(ver);
    return ver;
  }

  async addVersion(formulaId, body, { activate = false } = {}) {
    return this.store.mutate((db) => {
      const formula = this.getFormula(db, formulaId);
      return this._addVersion(db, formula, body || {}, { activate: activate || body && body.activate === true });
    });
  }

  async activateVersion(formulaId, version) {
    return this.store.mutate((db) => {
      const formula = this.getFormula(db, formulaId);
      if (!formula.versions.some((v) => v.version === version)) {
        throw HttpError.notFound(`配方 ${formulaId} 不存在版本 ${version}`);
      }
      for (const v of formula.versions) {
        v.status = v.version === version ? "active" : "deprecated";
        if (v.version === version) v.activatedAt = this.now();
      }
      return formula.versions.find((v) => v.version === version);
    });
  }

  /**
   * 不落库的换算预览：用于下单前/草稿查看各组分用量。
   * body: { formulaId, version?, targetAmount, targetUnit, graduation }
   */
  async preview(body) {
    const db = await this.store.read();
    if (!body || !body.formulaId) throw HttpError.badRequest("缺少字段：formulaId");
    const { version } = body.version
      ? this.getVersion(db, body.formulaId, body.version)
      : this.activeVersion(db, body.formulaId);
    const reagents = this.reagentMap(db, version.components.map((c) => c.reagentId));
    try {
      return {
        formulaId: body.formulaId,
        version: version.version,
        ...computeMix({
          components: version.components,
          targetAmount: body.targetAmount,
          targetUnit: body.targetUnit,
          graduation: body.graduation,
          reagents
        })
      };
    } catch (e) {
      throw HttpError.unprocessable(e.message);
    }
  }

  // ---------- 校验闸门 ----------

  /**
   * 解析配方快照与用量换算。换算本身失败 -> 422。
   */
  _resolveMix(db, order) {
    const formula = db.formulas.find((f) => f.id === order.formulaId);
    if (!formula) {
      throw HttpError.unprocessable(`配方不存在：${order.formulaId}`);
    }
    const version = formula.versions.find((v) => v.version === order.formulaVersion);
    if (!version) {
      throw HttpError.unprocessable(`配方 ${order.formulaId} 版本 ${order.formulaVersion} 已不存在`);
    }
    const reagentIds = version.components.map((c) => c.reagentId);
    const missing = reagentIds.filter((id) => !db.reagents.some((r) => r.id === id));
    if (missing.length) throw HttpError.unprocessable(`组分药剂已删除：${missing.join(", ")}`);
    const reagents = this.reagentMap(db, reagentIds);
    let mix;
    try {
      mix = computeMix({
        components: version.components,
        targetAmount: order.targetAmount,
        targetUnit: order.targetUnit,
        graduation: order.graduation,
        reagents
      });
    } catch (e) {
      throw HttpError.unprocessable(`用量换算失败：${e.message}`);
    }
    return { formula, version, reagents, reagentIds, mix };
  }

  /**
   * 三类闸门：禁配（含间接）、间隔期、并发占用。
   * 422：禁配/间隔；409：同一药剂被其它已校验/已调配单占用。
   */
  _runGates(db, order, resolved) {
    const { version, reagentIds, mix } = resolved;

    // 1) 禁配（直接 + 间接，基于全局禁配图）
    const violations = checkIncompatibility(reagentIds, db.incompatRules);

    // 2) 间隔期：距上次「成功调配」（进入 mixed）未过间隔期
    const intervalBlocks = [];
    for (const id of reagentIds) {
      const reagent = resolved.reagents[id];
      if (!reagent.intervalHours) continue;
      const last = db.dispensingOrders
        .filter((o) => o.status === "mixed" || o.status === "used")
        .filter((o) => o.id !== order.id)
        .filter((o) => (o.componentsSnapshot || []).some((it) => it.reagentId === id))
        .map((o) => o.mixedAt)
        .filter(Boolean)
        .sort()
        .pop();
      if (!last) continue;
      const elapsedMs = new Date(this.now()).getTime() - new Date(last).getTime();
      const waitMs = reagent.intervalHours * HOUR_MS;
      if (elapsedMs < waitMs) {
        intervalBlocks.push({
          reagentId: id,
          reagentName: reagent.name,
          intervalHours: reagent.intervalHours,
          lastMixedAt: last,
          remainingHours: roundTo((waitMs - elapsedMs) / HOUR_MS, 2)
        });
      }
    }

    // 3) 同一药剂同时刻只归一张调配单：validated / mixed 视为占用
    const heldBy = {};
    for (const other of db.dispensingOrders) {
      if (other.id === order.id) continue;
      if (other.status !== "validated" && other.status !== "mixed") continue;
      for (const it of other.componentsSnapshot || []) heldBy[it.reagentId] = other.id;
    }
    const occupied = reagentIds.filter((id) => heldBy[id]).map((id) => ({ reagentId: id, orderId: heldBy[id] }));

    if (violations.length || intervalBlocks.length) {
      throw HttpError.unprocessable("校验未通过，整单拒绝", { violations, intervalBlocks });
    }
    if (occupied.length) {
      throw HttpError.conflict("组分药剂被其它未完结调配单占用", { occupied });
    }
    return { formulaSnapshot: resolved.formula, versionSnapshot: version, mix };
  }

  _snapshot(order, resolved, gate) {
    order.formulaName = gate.formulaSnapshot.name;
    order.componentsSnapshot = gate.mix.items.map((it) => ({ ...it }));
    order.totals = { ...gate.mix.totals };
  }

  // ---------- 调配单 ----------

  async listOrders(query = {}) {
    const db = await this.store.read();
    let orders = db.dispensingOrders;
    if (query.status) orders = orders.filter((o) => o.status === query.status);
    if (query.formulaId) orders = orders.filter((o) => o.formulaId === query.formulaId);
    if (query.formulaVersion) orders = orders.filter((o) => o.formulaVersion === query.formulaVersion);
    return orders;
  }

  async getOrderDetail(id) {
    const db = await this.store.read();
    return this.getOrder(db, id);
  }

  async createOrder(body) {
    if (!body || !body.formulaId) throw HttpError.badRequest("缺少字段：formulaId");
    if (!isPositiveNumber(body.targetAmount)) throw HttpError.badRequest("targetAmount 必须为正数");
    if (!body.targetUnit || dimensionOf(body.targetUnit) === null) {
      throw HttpError.badRequest("targetUnit 必须是 mg/g/kg/mL/L 之一");
    }
    if (!isPositiveNumber(body.graduation)) throw HttpError.badRequest("graduation（最小分度）必须为正数");
    try {
      decimalsFromGraduation(body.graduation);
    } catch (e) {
      throw HttpError.badRequest(e.message);
    }

    return this.store.mutate((db) => {
      // clientToken 幂等：相同令牌直接回放上一张单
      if (body.clientToken) {
        const existed = db.clientTokens[body.clientToken];
        if (existed) {
          const prev = this.getOrder(db, existed, { required: false });
          if (prev) return { ...prev, idempotentReplay: true };
        }
      }
      // 解析并钉住配方版本（显式 version 优先，否则当前 active）
      const picked = body.version
        ? this.getVersion(db, body.formulaId, body.version)
        : this.activeVersion(db, body.formulaId);
      const order = {
        id: makeId("disp", this.clock),
        code: body.code || "",
        formulaId: body.formulaId,
        formulaName: picked.formula.name,
        formulaVersion: picked.version.version,
        targetAmount: body.targetAmount,
        targetUnit: body.targetUnit,
        graduation: body.graduation,
        status: "draft",
        note: body.note || "",
        componentsSnapshot: null,
        totals: null,
        damageId: body.damageId || null,
        createdAt: this.now(),
        validatedAt: null,
        mixedAt: null,
        usedAt: null,
        discardedAt: null
      };
      db.dispensingOrders.push(order);
      if (body.clientToken) db.clientTokens[body.clientToken] = order.id;
      return order;
    });
  }

  /** draft -> validated；重复校验幂等 */
  async validateOrder(id, body = {}) {
    return this.store.mutate((db) => {
      const order = this.getOrder(db, id);
      if (order.status === "validated" || order.status === "mixed" || order.status === "used") {
        return { ...order, idempotentReplay: true };
      }
      if (order.status === "discarded") throw HttpError.conflict("调配单已废弃，不能校验");
      const resolved = this._resolveMix(db, order); // 换算失败直接 422，不落库
      const gate = this._runGates(db, order, resolved);
      this._snapshot(order, resolved, gate);
      order.status = "validated";
      order.validatedAt = this.now();
      return order;
    });
  }

  /** validated -> mixed（成功调配）；调配时刻重新跑全部闸门 */
  async mixOrder(id, body = {}) {
    return this.store.mutate((db) => {
      const order = this.getOrder(db, id);
      if (order.status === "mixed" || order.status === "used") {
        return { ...order, idempotentReplay: true };
      }
      if (order.status === "discarded") throw HttpError.conflict("调配单已废弃，不能调配");
      if (order.status === "draft") throw HttpError.conflict("调配单尚未校验通过，不能调配");
      const resolved = this._resolveMix(db, order);
      this._runGates(db, order, resolved); // 关键：占用/间隔以调配时刻为准
      order.status = "mixed";
      order.mixedAt = body.mixedAt || this.now();
      if (body.operator) order.operator = body.operator;
      return order;
    });
  }

  /** mixed -> used：登记使用，可按缺损项追溯；多个缺损项按 factors 比例分摊 */
  async useOrder(id, body = {}) {
    return this.store.mutate((db) => {
      const order = this.getOrder(db, id);
      if (order.status === "used") {
        const usage = db.usages.find((u) => u.orderId === id);
        return { order, usage, idempotentReplay: true };
      }
      if (order.status === "discarded") throw HttpError.conflict("调配单已废弃，不能登记使用");
      if (order.status !== "mixed") throw HttpError.conflict("只有已调配的单子可以登记使用");
      if (!order.componentsSnapshot) throw HttpError.unprocessable("调配单缺少用量快照");

      const allocations = this._buildAllocations(db, body);
      const decimals = decimalsFromGraduation(order.graduation);
      const factorSum = allocations.reduce((s, a) => s + a.factor, 0);
      const items = order.componentsSnapshot.map((it) => {
        const exact = allocations.map((a) => (it.amount * a.factor) / factorSum);
        const floors = exact.map((q) => Math.floor(Math.round((q / order.graduation) * 1e9) / 1e9) * order.graduation);
        const missing =
          Math.round(((it.amount - floors.reduce((s, v) => s + v, 0)) / order.graduation) * 1e6) / 1e6;
        const ranked = exact
          .map((q, i) => ({ i, remainder: q - floors[i] }))
          .sort((a, b) => b.remainder - a.remainder || a.i - b.i);
        const amounts = floors.slice();
        for (let k = 0; k < missing; k++) {
          const idx = ranked[k % ranked.length].i;
          amounts[idx] = roundTo(amounts[idx] + order.graduation, decimals);
        }
        return {
          reagentId: it.reagentId,
          unit: it.unit,
          splits: allocations.map((a, i) => ({
            damageId: a.damageId,
            amount: roundTo(amounts[i], decimals)
          }))
        };
      });
      // 守恒自检：分摊之和必须等于调配量（以目标单位计）
      for (const it of items) {
        const splitSum = roundTo(it.splits.reduce((s, x) => s + x.amount, 0), decimals);
        if (Math.abs(splitSum - order.componentsSnapshot.find((c) => c.reagentId === it.reagentId).amount) > 10 ** -decimals) {
          throw HttpError.unprocessable("使用分摊不守恒，整单回滚");
        }
      }

      const usage = {
        id: makeId("usage", this.clock),
        orderId: order.id,
        formulaId: order.formulaId,
        formulaVersion: order.formulaVersion,
        damageAllocations: allocations.map((a) => ({ damageId: a.damageId, factor: a.factor })),
        items,
        note: body.note || "",
        usedAt: body.usedAt || this.now()
      };
      db.usages.push(usage);
      order.status = "used";
      order.usedAt = usage.usedAt;
      // 使用后药剂不再被该单占用
      return { order, usage };
    });
  }

  _buildAllocations(db, body) {
    let allocations;
    if (Array.isArray(body.allocations) && body.allocations.length) {
      allocations = body.allocations.map((a) => ({
        damageId: a.damageId,
        factor: isPositiveNumber(a.factor) ? a.factor : 1
      }));
    } else if (body.damageId) {
      allocations = [{ damageId: body.damageId, factor: 1 }];
    } else {
      throw HttpError.badRequest("登记使用必须提供 damageId 或非空 allocations");
    }
    const ids = allocations.map((a) => a.damageId);
    const missing = ids.filter((id) => !db.damages.some((d) => d.id === id));
    if (missing.length) throw HttpError.badRequest(`缺损项不存在：${missing.join(", ")}`);
    return allocations;
  }

  /** validated / mixed -> discarded；已使用不可废弃 */
  async discardOrder(id, body = {}) {
    return this.store.mutate((db) => {
      const order = this.getOrder(db, id);
      if (order.status === "discarded") return { ...order, idempotentReplay: true };
      if (order.status === "used") throw HttpError.conflict("调配单已使用，不能废弃");
      if (order.status === "draft") throw HttpError.conflict("草稿请直接删除，或先校验再废弃");
      order.status = "discarded";
      order.discardReason = body.reason || "";
      order.discardedAt = this.now();
      return order;
    });
  }

  // ---------- 追溯 ----------

  async trace(query = {}) {
    const db = await this.store.read();
    let usages = db.usages;
    if (query.damageId) {
      usages = usages.filter((u) => u.damageAllocations.some((a) => a.damageId === query.damageId));
    }
    if (query.reagentId) {
      usages = usages.filter((u) => u.items.some((it) => it.reagentId === query.reagentId));
    }
    if (query.formulaId) usages = usages.filter((u) => u.formulaId === query.formulaId);
    if (query.formulaVersion) usages = usages.filter((u) => u.formulaVersion === query.formulaVersion);

    // 展开成逐缺损项、逐药剂的用量行，便于按缺损项/版本追溯
    const rows = [];
    for (const usage of usages) {
      const factorSum = usage.damageAllocations.reduce((s, a) => s + a.factor, 0);
      for (const alloc of usage.damageAllocations) {
        // usage 级过滤命中后，行展开只保留被查询的那个缺损项
        if (query.damageId && alloc.damageId !== query.damageId) continue;
        for (const it of usage.items) {
          // 按药剂过滤时，行级也只保留该药剂
          if (query.reagentId && it.reagentId !== query.reagentId) continue;
          const split = it.splits.find((s) => s.damageId === alloc.damageId);
          const reagent = db.reagents.find((r) => r.id === it.reagentId);
          const recordAmount = reagent
            ? roundTo(convert(split.amount, it.unit, reagent.recordUnit, reagent.density), 6)
            : split.amount;
          rows.push({
            usageId: usage.id,
            orderId: usage.orderId,
            damageId: alloc.damageId,
            factor: alloc.factor,
            factorShare: roundTo(alloc.factor / factorSum, 6),
            formulaId: usage.formulaId,
            formulaVersion: usage.formulaVersion,
            reagentId: it.reagentId,
            reagentName: reagent ? reagent.name : it.reagentId,
            amount: split.amount,
            unit: it.unit,
            recordAmount,
            recordUnit: reagent ? reagent.recordUnit : it.unit,
            usedAt: usage.usedAt
          });
        }
      }
    }
    return { usages, rows };
  }
}

module.exports = { Service, ORDER_STATUSES, VERSION_STATUSES };

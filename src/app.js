/**
 * HTTP 装配：拓片修补原有接口 + 药剂配方/调配域新接口。
 * 零依赖，createApp({ store, clock }) 便于测试注入。
 */

const http = require("http");
const { Service } = require("./service");
const { HttpError } = require("./errors");

function makeId(prefix, clock) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}

async function parseBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw HttpError.badRequest("请求体必须是合法JSON");
  }
}

function required(body, fields) {
  const missing = fields.filter((field) => body[field] === undefined || body[field] === "");
  if (missing.length) throw HttpError.badRequest(`缺少字段：${missing.join(", ")}`);
}

function createApp({ store, clock }) {
  const service = new Service(store, clock);

  async function handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;
    const q = url.searchParams;

    // ---------- 健康检查 ----------
    if (req.method === "GET" && pathname === "/health") {
      const routes = [
        "GET /health",
        "GET /reagents", "POST /reagents",
        "GET /incompat-rules", "POST /incompat-rules",
        "GET /formulas", "POST /formulas", "GET /formulas/:id",
        "POST /formulas/:id/versions", "POST /formulas/:id/versions/:version/activate",
        "POST /dispense/preview",
        "GET /dispense/orders", "POST /dispense/orders", "GET /dispense/orders/:id",
        "POST /dispense/orders/:id/validate", "POST /dispense/orders/:id/mix",
        "POST /dispense/orders/:id/use", "POST /dispense/orders/:id/discard",
        "GET /trace",
        "GET /rubbings", "POST /rubbings",
        "GET /rubbings/:id/damages", "POST /rubbings/:id/damages",
        "GET /damages", "PATCH /damages/:id",
        "GET /batches", "POST /batches", "GET /batches/:id", "POST /batches/:id/complete"
      ];
      return send(res, 200, { ok: true, service: "rubbing-restoration-api", routes });
    }

    // ---------- 药剂 ----------
    if (req.method === "GET" && pathname === "/reagents") {
      return send(res, 200, { data: await service.listReagents() });
    }
    if (req.method === "POST" && pathname === "/reagents") {
      return send(res, 201, { data: await service.createReagent(await parseBody(req)) });
    }

    // ---------- 禁配规则 ----------
    if (req.method === "GET" && pathname === "/incompat-rules") {
      return send(res, 200, { data: await service.listRules() });
    }
    if (req.method === "POST" && pathname === "/incompat-rules") {
      return send(res, 201, { data: await service.addRule(await parseBody(req)) });
    }

    // ---------- 配方 ----------
    if (req.method === "GET" && pathname === "/formulas") {
      return send(res, 200, { data: await service.listFormulas() });
    }
    if (req.method === "POST" && pathname === "/formulas") {
      return send(res, 201, { data: await service.createFormula(await parseBody(req)) });
    }

    const versionActivateMatch = pathname.match(/^\/formulas\/([^/]+)\/versions\/([^/]+)\/activate$/);
    if (versionActivateMatch && req.method === "POST") {
      const [, formulaId, version] = versionActivateMatch;
      await parseBody(req);
      return send(res, 200, { data: await service.activateVersion(formulaId, decodeURIComponent(version)) });
    }
    const versionsMatch = pathname.match(/^\/formulas\/([^/]+)\/versions$/);
    if (versionsMatch && req.method === "POST") {
      const body = await parseBody(req);
      return send(res, 201, { data: await service.addVersion(versionsMatch[1], body) });
    }
    const formulaMatch = pathname.match(/^\/formulas\/([^/]+)$/);
    if (formulaMatch && req.method === "GET") {
      return send(res, 200, { data: await service.getFormulaDetail(formulaMatch[1]) });
    }

    // ---------- 换算预览 ----------
    if (req.method === "POST" && pathname === "/dispense/preview") {
      const body = await parseBody(req);
      required(body, ["formulaId", "targetAmount", "targetUnit", "graduation"]);
      return send(res, 200, { data: await service.preview(body) });
    }

    // ---------- 调配单 ----------
    if (req.method === "GET" && pathname === "/dispense/orders") {
      return send(
        res,
        200,
        { data: await service.listOrders({
          status: q.get("status"),
          formulaId: q.get("formulaId"),
          formulaVersion: q.get("formulaVersion")
        }) }
      );
    }
    if (req.method === "POST" && pathname === "/dispense/orders") {
      const body = await parseBody(req);
      required(body, ["formulaId", "targetAmount", "targetUnit", "graduation"]);
      return send(res, 201, { data: await service.createOrder(body) });
    }

    const orderMatch = pathname.match(/^\/dispense\/orders\/([^/]+)\/(validate|mix|use|discard)$/);
    if (orderMatch && req.method === "POST") {
      const [, id, action] = orderMatch;
      const body = await parseBody(req);
      const map = {
        validate: () => service.validateOrder(id, body),
        mix: () => service.mixOrder(id, body),
        use: () => service.useOrder(id, body),
        discard: () => service.discardOrder(id, body)
      };
      const result = await map[action]();
      return send(res, 200, { data: result });
    }
    const orderGetMatch = pathname.match(/^\/dispense\/orders\/([^/]+)$/);
    if (orderGetMatch && req.method === "GET") {
      return send(res, 200, { data: await service.getOrderDetail(orderGetMatch[1]) });
    }

    // ---------- 追溯 ----------
    if (req.method === "GET" && pathname === "/trace") {
      return send(
        res,
        200,
        { data: await service.trace({
          damageId: q.get("damageId"),
          reagentId: q.get("reagentId"),
          formulaId: q.get("formulaId"),
          formulaVersion: q.get("formulaVersion")
        }) }
      );
    }

    // ================= 以下为原有拓片修补接口（行为不变） =================

    if (req.method === "GET" && pathname === "/rubbings") {
      const db = await store.read();
      const data = db.rubbings.map((rubbing) => {
        const damages = db.damages.filter((item) => item.rubbingId === rubbing.id);
        return {
          ...rubbing,
          damageCount: damages.length,
          pendingDamages: damages.filter((item) => item.status !== "repaired").length
        };
      });
      return send(res, 200, { data });
    }

    if (req.method === "POST" && pathname === "/rubbings") {
      const body = await parseBody(req);
      required(body, ["code", "source", "paperSize"]);
      const rubbing = await store.mutate((db) => {
        const item = {
          id: makeId("rubbing", clock),
          code: body.code,
          source: body.source,
          paperSize: body.paperSize,
          note: body.note || "",
          createdAt: clock()
        };
        db.rubbings.push(item);
        return item;
      });
      return send(res, 201, { data: rubbing });
    }

    const rubbingDamagesMatch = pathname.match(/^\/rubbings\/([^/]+)\/damages$/);
    if (rubbingDamagesMatch && req.method === "GET") {
      const db = await store.read();
      const rubbingId = rubbingDamagesMatch[1];
      if (!db.rubbings.some((r) => r.id === rubbingId)) return send(res, 404, { error: "拓片不存在" });
      return send(res, 200, { data: db.damages.filter((item) => item.rubbingId === rubbingId) });
    }
    if (rubbingDamagesMatch && req.method === "POST") {
      const rubbingId = rubbingDamagesMatch[1];
      const body = await parseBody(req);
      required(body, ["position", "type", "beforePhotoUrl"]);
      const damage = await store.mutate((db) => {
        if (!db.rubbings.some((r) => r.id === rubbingId)) throw HttpError.notFound("拓片不存在");
        const item = {
          id: makeId("damage", clock),
          rubbingId,
          position: body.position,
          type: body.type,
          beforePhotoUrl: body.beforePhotoUrl,
          afterPhotoUrl: "",
          status: "pending",
          repairNote: "",
          batchId: null,
          createdAt: clock(),
          repairedAt: null
        };
        db.damages.push(item);
        return item;
      });
      return send(res, 201, { data: damage });
    }

    if (req.method === "GET" && pathname === "/damages") {
      const db = await store.read();
      const status = q.get("status");
      const type = q.get("type");
      const data = db.damages.filter(
        (item) => (!status || item.status === status) && (!type || item.type === type)
      );
      return send(res, 200, { data });
    }

    const damagePatchMatch = pathname.match(/^\/damages\/([^/]+)$/);
    if (damagePatchMatch && req.method === "PATCH") {
      const damageId = damagePatchMatch[1];
      const body = await parseBody(req);
      const damage = await store.mutate((db) => {
        const item = db.damages.find((d) => d.id === damageId);
        if (!item) throw HttpError.notFound("缺损项不存在");
        Object.assign(item, {
          position: body.position ?? item.position,
          type: body.type ?? item.type,
          beforePhotoUrl: body.beforePhotoUrl ?? item.beforePhotoUrl,
          afterPhotoUrl: body.afterPhotoUrl ?? item.afterPhotoUrl,
          status: body.status ?? item.status,
          repairNote: body.repairNote ?? item.repairNote
        });
        item.repairedAt = item.status === "repaired" ? clock() : item.repairedAt;
        return item;
      });
      return send(res, 200, { data: damage });
    }

    const enrichBatch = (db, batch) => {
      const damages = db.damages.filter((item) => batch.damageIds.includes(item.id));
      return {
        ...batch,
        damages,
        total: damages.length,
        repaired: damages.filter((item) => item.status === "repaired").length,
        pending: damages.filter((item) => item.status !== "repaired").length
      };
    };

    if (req.method === "GET" && pathname === "/batches") {
      const db = await store.read();
      return send(res, 200, { data: db.batches.map((b) => enrichBatch(db, b)) });
    }
    if (req.method === "POST" && pathname === "/batches") {
      const body = await parseBody(req);
      required(body, ["name", "damageIds"]);
      if (!Array.isArray(body.damageIds) || body.damageIds.length === 0) {
        throw HttpError.badRequest("damageIds必须是非空数组");
      }
      const batch = await store.mutate((db) => {
        const invalid = body.damageIds.filter((id) => !db.damages.some((d) => d.id === id));
        if (invalid.length) throw HttpError.badRequest(`缺损项不存在：${invalid.join(", ")}`);
        const item = {
          id: makeId("batch", clock),
          name: body.name,
          status: "open",
          damageIds: body.damageIds,
          note: body.note || "",
          createdAt: clock(),
          completedAt: null
        };
        db.batches.push(item);
        db.damages.forEach((damage) => {
          if (body.damageIds.includes(damage.id)) {
            damage.batchId = item.id;
            damage.status = "in_repair";
          }
        });
        return enrichBatch(db, item);
      });
      return send(res, 201, { data: batch });
    }

    const completeMatch = pathname.match(/^\/batches\/([^/]+)\/complete$/);
    if (completeMatch && req.method === "POST") {
      const batchId = completeMatch[1];
      const body = await parseBody(req);
      const batch = await store.mutate((db) => {
        const item = db.batches.find((b) => b.id === batchId);
        if (!item) throw HttpError.notFound("修补批次不存在");
        const results = Array.isArray(body.results) ? body.results : [];
        item.status = "completed";
        item.completedAt = clock();
        item.note = body.note ?? item.note;
        db.damages.forEach((damage) => {
          if (!item.damageIds.includes(damage.id)) return;
          const result = results.find((r) => r.damageId === damage.id) || {};
          damage.status = "repaired";
          damage.afterPhotoUrl = result.afterPhotoUrl || body.defaultAfterPhotoUrl || damage.afterPhotoUrl;
          damage.repairNote = result.repairNote || body.defaultRepairNote || damage.repairNote;
          damage.repairedAt = clock();
        });
        return enrichBatch(db, item);
      });
      return send(res, 200, { data: batch });
    }
    const batchGetMatch = pathname.match(/^\/batches\/([^/]+)$/);
    if (batchGetMatch && req.method === "GET") {
      const db = await store.read();
      const batch = db.batches.find((b) => b.id === batchGetMatch[1]);
      if (!batch) return send(res, 404, { error: "修补批次不存在" });
      return send(res, 200, { data: enrichBatch(db, batch) });
    }

    return send(res, 404, { error: "接口不存在" });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      if (error instanceof HttpError) {
        return send(res, error.status, error.details ? { error: error.message, details: error.details } : { error: error.message });
      }
      return send(res, 500, { error: error.message || "服务器错误" });
    });
  });

  return { server, service };
}

module.exports = { createApp };

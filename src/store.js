/**
 * JSON 文件存储。
 *
 * 并发保证（进程内单实例）：
 *  - 所有写操作经过同一把异步互斥锁串行化，读-校验-写在一个临界区内完成；
 *  - 落盘走 “临时文件 + rename” 原子替换，避免写一半的 db.json 被读到；
 *  - 临界区内重新读取文件内容，锁外排队的请求不会基于过期数据做判断。
 * 多进程部署需换成带事务的数据库（见 README 局限说明）。
 */

const { readFile, writeFile, rename, mkdir } = require("fs/promises");
const path = require("path");
const { randomUUID } = require("crypto");
const { seed } = require("./seed");

const COLLECTIONS = [
  "rubbings",
  "damages",
  "batches",
  "reagents",
  "incompatRules",
  "formulas",
  "dispensingOrders",
  "usages",
  "clientTokens"
];

class JsonStore {
  constructor(file, clock = () => new Date().toISOString()) {
    this.file = file;
    this.clock = clock;
    this.tail = Promise.resolve();
    this.ensured = false;
  }

  async ensure() {
    if (this.ensured) return;
    await mkdir(path.dirname(this.file), { recursive: true });
    try {
      JSON.parse(await readFile(this.file, "utf8"));
    } catch {
      await writeFile(this.file, JSON.stringify(seed(this.clock()), null, 2));
    }
    // 老库迁移：补齐缺失集合；药剂域新集合为空时灌入演示数据
    const db = JSON.parse(await readFile(this.file, "utf8"));
    let changed = false;
    const demo = seed(this.clock());
    for (const name of COLLECTIONS) {
      if (db[name] === undefined) {
        db[name] = name === "clientTokens" ? {} : demo[name];
        changed = true;
      } else if (Array.isArray(db[name]) && db[name].length === 0 && Array.isArray(demo[name]) && demo[name].length) {
        // 已存在但为空的药剂域集合，补演示数据；业务集合（batches 等）保持空
        if (["reagents", "incompatRules", "formulas"].includes(name)) {
          db[name] = demo[name];
          changed = true;
        }
      }
    }
    if (changed) await writeFile(this.file, JSON.stringify(db, null, 2));
    this.ensured = true;
  }

  async read() {
    await this.ensure();
    return JSON.parse(await readFile(this.file, "utf8"));
  }

  async atomicWrite(db) {
    const tmp = path.join(path.dirname(this.file), `.db.${process.pid}.${randomUUID()}.tmp`);
    await writeFile(tmp, JSON.stringify(db, null, 2));
    await rename(tmp, this.file);
  }

  /**
   * 在互斥临界区内执行 fn(db)。
   * fn 返回 { result, persist=true } 或直接返回 result；
   * fn 抛出则不写库（整单回滚），错误继续向上抛。
   */
  async mutate(fn) {
    const run = this.tail.then(async () => {
      const db = await this.read();
      const out = await fn(db);
      if (out && Object.prototype.hasOwnProperty.call(out, "result")) {
        if (out.persist !== false) await this.atomicWrite(db);
        return out.result;
      }
      await this.atomicWrite(db);
      return out;
    });
    // 不让单个失败冲断整条链
    this.tail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }
}

module.exports = { JsonStore, COLLECTIONS };

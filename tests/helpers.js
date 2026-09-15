/**
 * 测试公共辅助：临时库文件、可控时钟、service 装配。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { JsonStore } = require("../src/store");
const { Service } = require("../src/service");

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rubbing-test-"));
  return path.join(dir, "db.json");
}

/**
 * 可控时钟：clock() 取当前时刻，advance/advanceHours 推进。
 */
function fakeClock(start = "2026-01-01T00:00:00.000Z") {
  let t = new Date(start).getTime();
  const clock = () => new Date(t).toISOString();
  clock.advance = (ms) => {
    t += ms;
  };
  clock.advanceHours = (h) => clock.advance(h * 3600_000);
  clock.set = (iso) => {
    t = new Date(iso).getTime();
  };
  clock.millis = () => t;
  return clock;
}

function makeService(file = tempDb(), clock = fakeClock()) {
  const store = new JsonStore(file, clock);
  const service = new Service(store, clock);
  return { service, store, clock, file };
}

module.exports = { tempDb, fakeClock, makeService };

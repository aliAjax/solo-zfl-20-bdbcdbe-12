/**
 * 启动入口：古籍拓片修补 —— 药剂配方与调配服务。
 *   PORT     监听端口，默认 3020
 *   DB_FILE  JSON 数据库路径，默认 ./data/db.json
 */

const path = require("path");
const { JsonStore } = require("./src/store");
const { createApp } = require("./src/app");

const PORT = Number(process.env.PORT || 3020);
const DB_FILE = process.env.DB_FILE || path.join(__dirname, "data", "db.json");
const clock = () => new Date().toISOString();

const store = new JsonStore(DB_FILE, clock);
const { server } = createApp({ store, clock });

server.listen(PORT, () => {
  console.log(`拓片修补药剂调配服务已启动: http://127.0.0.1:${PORT}`);
  console.log(`数据库: ${DB_FILE}`);
  console.log(`接口一览: GET /health`);
});

module.exports = { server, store };

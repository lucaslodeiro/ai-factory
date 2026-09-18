import fs from "node:fs";
import { parse } from "dotenv";

const values = fs.existsSync(".env") ? parse(fs.readFileSync(".env","utf8")) : {};
const host = values.FACTORY_DASHBOARD_HOST || "127.0.0.1";
const port = values.FACTORY_DASHBOARD_PORT || "4173";
const url = `http://${host === "::1" ? "[::1]" : host}:${port}`;

console.log(`
AI Factory service commands
  Dashboard: ${url}
  Start all: npm run service -- start all
  Status:    npm run service -- status all
  Restart:   npm run service -- restart daemon
             npm run service -- restart dashboard
  Logs:      npm run service -- logs daemon
             npm run service -- logs dashboard
             npm run service -- logs all
  Stop all:  npm run service -- stop all
`);

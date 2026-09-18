import { execFileSync } from "node:child_process";
const url = execFileSync(process.execPath,["scripts/dashboard-url.mjs"],{encoding:"utf8"});

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

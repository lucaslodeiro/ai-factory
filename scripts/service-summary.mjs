import { execFileSync } from "node:child_process";
const url = execFileSync(process.execPath,["scripts/dashboard-url.mjs"],{encoding:"utf8"});

console.log(`
AI Factory service commands
  Dashboard: ${url}
  Start all: ai-factory service start all
  Status:    ai-factory service status all
  Restart:   ai-factory service restart daemon
             ai-factory service restart dashboard
  Logs:      ai-factory service logs daemon
             ai-factory service logs dashboard
             ai-factory service logs all
  Stop all:  ai-factory service stop all
`);

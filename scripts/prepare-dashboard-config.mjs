import fs from "node:fs";
import net from "node:net";
import { parse } from "dotenv";
import { environmentFile } from "./paths.mjs";

const file = environmentFile;
const original = fs.readFileSync(file,"utf8");
const values = parse(original);
const requestedHost = process.argv[2] || values.FACTORY_DASHBOARD_HOST || "127.0.0.1";
const initialPort = Number(process.argv[3] || values.FACTORY_DASHBOARD_PORT || "4173");
if (!["127.0.0.1","localhost","::1"].includes(requestedHost)) throw new Error("Dashboard host must be 127.0.0.1, localhost or ::1");
if (!Number.isSafeInteger(initialPort) || initialPort < 1 || initialPort > 65535) throw new Error("Dashboard port must be from 1 to 65535");

const available = (host,port) => new Promise(resolve => {
  const server = net.createServer();
  server.unref();
  server.once("error",() => resolve(false));
  server.listen({host,port,exclusive:true},() => server.close(() => resolve(true)));
});

let selectedPort;
for (let offset=0; offset<200; offset++) {
  const candidate = initialPort + offset;
  if (candidate > 65535) break;
  if (await available(requestedHost,candidate)) { selectedPort=candidate; break; }
}
if (!selectedPort) throw new Error(`No free dashboard port found from ${initialPort} through ${Math.min(initialPort+199,65535)}`);
if (selectedPort !== initialPort) console.error(`Dashboard port ${initialPort} is occupied; using ${selectedPort}.`);

const replace = (text,key,value) => text.replace(new RegExp(`^${key}=.*$`,`m`),`${key}=${value}`);
const updated = replace(replace(original,"FACTORY_DASHBOARD_HOST",requestedHost),"FACTORY_DASHBOARD_PORT",String(selectedPort));
const temporary = `${file}.dashboard-${process.pid}`;
try {
  fs.writeFileSync(temporary,updated,{mode:0o600,flag:"wx"});
  fs.renameSync(temporary,file);
} finally { fs.rmSync(temporary,{force:true}); }
process.stdout.write(`http://${requestedHost === "::1" ? "[::1]" : requestedHost}:${selectedPort}`);

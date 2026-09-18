import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "dotenv";

const source = fileURLToPath(new URL("..",import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(),"factory-dashboard-port-"));
const occupied = net.createServer();
try {
  fs.copyFileSync(path.join(source,".env.example"),path.join(root,".env"));
  await new Promise((resolve,reject) => { occupied.once("error",reject); occupied.listen(0,"127.0.0.1",resolve); });
  const initialPort = occupied.address().port;
  const result = await new Promise((resolve,reject) => {
    const child = spawn(process.execPath,[path.join(source,"scripts","prepare-dashboard-config.mjs"),"127.0.0.1",String(initialPort)],{cwd:root});
    let stdout="",stderr="";
    child.stdout.on("data",chunk => stdout+=chunk);
    child.stderr.on("data",chunk => stderr+=chunk);
    child.once("error",reject);
    child.once("exit",code => resolve({code,stdout,stderr}));
  });
  assert.equal(result.code,0,result.stderr);
  const selectedPort = Number(new URL(result.stdout).port);
  assert.equal(selectedPort,initialPort+1);
  assert.match(result.stderr,new RegExp(`port ${initialPort} is occupied; using ${selectedPort}`));
  const values = parse(fs.readFileSync(path.join(root,".env"),"utf8"));
  assert.equal(values.FACTORY_DASHBOARD_HOST,"127.0.0.1");
  assert.equal(values.FACTORY_DASHBOARD_PORT,String(selectedPort));
  assert.equal(fs.statSync(path.join(root,".env")).mode & 0o777,0o600);
  console.log("PASS: dashboard host/port selection and occupied-port fallback");
} finally {
  await new Promise(resolve => occupied.close(resolve));
  fs.rmSync(root,{recursive:true,force:true});
}

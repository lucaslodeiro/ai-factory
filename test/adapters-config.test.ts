import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";

for(const provider of ["codex","claude"]){
 test(`adapter tests are independent of installed ${provider}-only role settings`,()=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),"factory-adapter-config-"));
  const roles=["PRODUCT_ARCHITECT","DEVELOPER","QA","REVIEWER"],env:NodeJS.ProcessEnv={...process.env,AI_FACTORY_HOME:home,FACTORY_DATA_DIR:path.join(home,"data")};
  delete env.NODE_TEST_CONTEXT;
  try{
   fs.writeFileSync(path.join(home,".env"),roles.map(role=>`${role}_PROVIDER=${provider}\n${role}_MODEL=auto`).join("\n"));
   for(const role of roles){delete env[`${role}_PROVIDER` as keyof typeof env];delete env[`${role}_MODEL` as keyof typeof env];}
   const result=spawnSync(process.execPath,["--import","tsx","--test",fileURLToPath(new URL("./adapters.test.ts",import.meta.url))],{env,encoding:"utf8",timeout:30000});
   assert.equal(result.status,0,result.stdout+result.stderr);
   assert.match(result.stdout,/# tests 1/);
  }finally{fs.rmSync(home,{recursive:true,force:true});}
 });
}

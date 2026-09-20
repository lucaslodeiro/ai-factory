import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "dotenv";
import { validateSetting } from "../dist/src/dashboard-settings.js";
import { environmentFile } from "./paths.mjs";

if (fs.existsSync(environmentFile)) process.exit(0);

const root=path.resolve(fileURLToPath(new URL("..",import.meta.url)));
const template=fs.readFileSync(path.join(root,".env.example"),"utf8");
const defaults=parse(template),values={...defaults};
const imported=[];
for(const key of Object.keys(defaults)){
  if(!Object.hasOwn(process.env,key))continue;
  values[key]=process.env[key]??"";
  imported.push(key);
}
const encode=value=>{
  if(/[\r\n\0]/.test(value))throw new Error("Use a single line");
  for(const quote of ["'","`",'"'])if(!value.includes(quote)&&!(quote==='"'&&/\\[nr]/.test(value)))return quote+value+quote;
  throw new Error("Value contains an unsupported combination of quotes");
};
for(const key of Object.keys(defaults))validateSetting(key,values[key]??"");
const output=template.replace(/^([A-Z_][A-Z0-9_]*)=.*$/gm,(line,key)=>imported.includes(key)?`${key}=${encode(values[key]??"")}`:line);
fs.writeFileSync(environmentFile,output,{mode:0o600,flag:"wx"});
console.log(imported.length?`Initial configuration imported ${imported.length} exported setting${imported.length===1?"":"s"}.`:"Initial configuration created from defaults.");

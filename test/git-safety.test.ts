import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

function sources(directory:string):string[]{return fs.readdirSync(directory,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?sources(path.join(directory,entry.name)):entry.isFile()? [path.join(directory,entry.name)]:[]);}

test("workflow synchronization never uses destructive conflict resolution",()=>{
 const forbidden=["reset --hard","-X ours","-X theirs","--strategy-option","checkout -- ."],arrayForms=[/["']reset["']\s*,\s*["']--hard["']/,/["']-X["']\s*,\s*["']ours["']/,/["']-X["']\s*,\s*["']theirs["']/,/["']--strategy-option["']/,/["']checkout["']\s*,\s*["']--["']\s*,\s*["']\.["']/];
 for(const file of [...sources("src"),...sources("scripts")]){const body=fs.readFileSync(file,"utf8");for(const token of forbidden)assert.equal(body.includes(token),false,`${file} contains forbidden Git operation ${token}`);for(const pattern of arrayForms)assert.doesNotMatch(body,pattern,`${file} contains forbidden array-form Git operation ${pattern}`);}
});

test("Factory branch publication never force-pushes refs under refs/heads",()=>{
 for(const file of [...sources("src"),...sources("scripts")]){
  const body=fs.readFileSync(file,"utf8"),commands=[...body.matchAll(/\[[^\]]*["']push["'][^\]]*refs\/heads\/[^\]]*\]/gs)].map(match=>match[0]);
  for(const command of commands)assert.doesNotMatch(command,/["'](?:--force|--force-with-lease|-f)["']/,`${file} force-pushes a branch: ${command}`);
  for(const line of body.split(/\r?\n/))if(/\bgit\s+push\b/.test(line)&&/refs\/heads\//.test(line))assert.doesNotMatch(line,/(?:^|\s)(?:--force(?:-with-lease)?|-f)(?:\s|$)/,`${file} force-pushes a branch: ${line}`);
 }
});

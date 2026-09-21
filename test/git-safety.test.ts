import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

function sources(directory:string):string[]{return fs.readdirSync(directory,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?sources(path.join(directory,entry.name)):entry.isFile()? [path.join(directory,entry.name)]:[]);}

test("workflow synchronization never uses destructive conflict resolution",()=>{
 const forbidden=["reset --hard","-X ours","-X theirs","--strategy-option","checkout -- ."];
 for(const file of [...sources("src"),...sources("scripts")]){const body=fs.readFileSync(file,"utf8");for(const token of forbidden)assert.equal(body.includes(token),false,`${file} contains forbidden Git operation ${token}`);}
});

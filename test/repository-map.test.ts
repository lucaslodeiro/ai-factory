import test from "node:test";
import assert from "node:assert/strict";
import { buildRepositoryMap, repositoryMapLimits } from "../src/repository-map.js";

test("the map reports directories, how many tracked files each holds and which kinds",()=>{
 const map=buildRepositoryMap(["package.json","README.md","src/cli.ts","src/config.ts","src/adapters/codex.ts","test/cli.test.ts","docs/guide.md"])!;
 assert.equal(map.files,7);
 assert.deepEqual(map.rootFiles,["README.md","package.json"]);
 assert.deepEqual(map.directories,["src 2 .ts","docs 1 .md","src/adapters 1 .ts","test 1 .ts"]);
 assert.equal(map.truncated,false);
 assert.match(map.legend,/tracked files/);
});

test("a deep tree rolls up into its ancestor instead of listing every leaf",()=>{
 const files=["a/b/c/d/one.ts","a/b/c/d/two.ts","a/b/other.ts"];
 const map=buildRepositoryMap(files)!;
 assert.deepEqual(map.directories,["a/b 3 .ts"]);
 assert.equal(map.files,3);
});

test("the map is bounded and says so when it leaves something out",()=>{
 const directories=Array.from({length:repositoryMapLimits.directories+5},(_,index)=>`dir${String(index).padStart(3,"0")}/file.ts`);
 const roots=Array.from({length:repositoryMapLimits.rootFiles+5},(_,index)=>`root${index}.md`);
 const map=buildRepositoryMap([...directories,...roots])!;
 assert.equal(map.directories.length,repositoryMapLimits.directories);
 assert.equal(map.rootFiles.length,repositoryMapLimits.rootFiles);
 assert.equal(map.truncated,true);
 assert.equal(map.files,directories.length+roots.length,"the total still counts every tracked file");
});

test("an empty or untracked checkout produces no map rather than an empty one",()=>{
 assert.equal(buildRepositoryMap([]),undefined);
 assert.equal(buildRepositoryMap(["","  ",""]),undefined);
});

test("a file without an extension contributes to the count without inventing a kind",()=>{
 const map=buildRepositoryMap(["bin/run","bin/run.sh"])!;
 assert.deepEqual(map.directories,["bin 2 .sh"]);
});

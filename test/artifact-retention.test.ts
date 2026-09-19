import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {Store} from "../src/storage.js";
import {config} from "../src/config.js";
import {pruneExecutionArtifacts} from "../src/artifact-retention.js";

test("retention removes sensitive execution content but preserves manifest and provenance",()=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),"factory-retention-")),oldDir=config.dataDir,oldDays=config.artifactRetentionDays;config.dataDir=root;config.artifactRetentionDays=30;const store=new Store(":memory:");try{store.db.prepare("INSERT INTO work_items(id,issue_number,repo,created_at,updated_at,context,stage,status) VALUES('w',1,'owner/repo',?,?, '{}','DELIVERY','COMPLETED')").run("2020-01-01","2020-01-01");store.db.prepare("INSERT INTO executions(id,work_item_id,role,status,started_at,prompt_bytes,prompt_sha256) VALUES('run','w','reviewer','succeeded','2020-01-01',12,'hash')").run();const directory=path.join(root,"runs","run");fs.mkdirSync(directory,{recursive:true});for(const name of ["prompt.md","prompt.json","stdout.log","stderr.log","completion.json"])fs.writeFileSync(path.join(directory,name),name,{mode:0o600});const result=pruneExecutionArtifacts(store,new Date("2026-01-01").getTime());assert.equal(result.files,4);assert.equal(fs.existsSync(path.join(directory,"prompt.json")),true);for(const name of ["prompt.md","stdout.log","stderr.log","completion.json"])assert.equal(fs.existsSync(path.join(directory,name)),false);assert.deepEqual(store.db.prepare("SELECT prompt_bytes,prompt_sha256 FROM executions WHERE id='run'").get(),{prompt_bytes:12,prompt_sha256:"hash"});}finally{store.db.close();config.dataDir=oldDir;config.artifactRetentionDays=oldDays;fs.rmSync(root,{recursive:true,force:true});}});

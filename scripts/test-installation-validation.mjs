import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import Database from 'better-sqlite3';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'factory-install-validation-'));
try{
 const database=path.join(root,'live.db'),db=new Database(database);
 db.exec('CREATE TABLE keep(value TEXT); INSERT INTO keep VALUES (\'preserved\');');db.close();
 const before=fs.readFileSync(database),script=fileURLToPath(new URL('./validate-installation.mjs',import.meta.url));
 const env={...process.env,AI_FACTORY_HOME:root};
 const fresh=spawnSync(process.execPath,[script],{env,encoding:'utf8'});
 assert.equal(fresh.status,0,fresh.stdout+fresh.stderr);
 assert.equal(fs.existsSync(path.join(root,'data','factory.db')),false);
 const incompatible=spawnSync(process.execPath,[script,database],{env,encoding:'utf8'});
 assert.notEqual(incompatible.status,0);assert.match(incompatible.stderr,/Unsupported AI Factory database schema/);
 assert.deepEqual(fs.readFileSync(database),before);
 assert.deepEqual(fs.readdirSync(root),['live.db']);
 console.log('PASS: installation checks use disposable storage and preserve an incompatible live database.');
}finally{fs.rmSync(root,{recursive:true,force:true});}

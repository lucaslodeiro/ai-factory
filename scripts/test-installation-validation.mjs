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
 const v5=path.join(root,'v5.db'),previous=new Database(v5);
 previous.exec(fs.readFileSync(new URL('../test/fixtures/schema-v5.sql',import.meta.url),'utf8'));previous.close();
 const v5Before=fs.readFileSync(v5);
 const upgraded=spawnSync(process.execPath,[script,v5],{env,encoding:'utf8'});
 assert.equal(upgraded.status,0,upgraded.stdout+upgraded.stderr);
 assert.deepEqual(fs.readFileSync(v5),v5Before,'validation must migrate only its disposable copy');
 console.log('PASS: installation checks use disposable storage and preserve an incompatible live database.');
}finally{fs.rmSync(root,{recursive:true,force:true});}

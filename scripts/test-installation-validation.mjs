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
 assert.notEqual(incompatible.status,0);assert.equal(incompatible.stderr.trim(),'Incompatible database schema: uninstall and reinstall with an empty data directory');
 assert.deepEqual(fs.readFileSync(database),before);
 const {schemaVersion}=await import('../dist/src/storage.js');
 const previous=path.join(root,'previous.db'),previousDb=new Database(previous);
 previousDb.exec(`CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL); INSERT INTO metadata VALUES('schema_version','${schemaVersion-1}'); CREATE TABLE keep(value TEXT); INSERT INTO keep VALUES('previous workflow');`);previousDb.close();
 const previousBytes=fs.readFileSync(previous);
 const outdated=spawnSync(process.execPath,[script,previous],{env,encoding:'utf8'});
 assert.notEqual(outdated.status,0);assert.match(outdated.stderr,/Incompatible database schema/);
 assert.deepEqual(fs.readFileSync(previous),previousBytes);
 assert.deepEqual(fs.readdirSync(root).sort(),['live.db','previous.db']);
 console.log('PASS: installation checks use disposable storage, refuse incompatible schemas cleanly and preserve the live database.');
}finally{fs.rmSync(root,{recursive:true,force:true});}

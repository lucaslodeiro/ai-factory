import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {home} from './paths.mjs';

const engine=fileURLToPath(new URL('..',import.meta.url));
if(Number(process.versions.node.split('.')[0])<22)throw new Error('Node 22+ is required');
for(const name of ['dist/src/cli.js','dist/src/storage.js','dist/src/worker-supervisor.mjs','dist/dashboard/index.html']){
 fs.accessSync(path.join(engine,name),fs.constants.R_OK);
}
fs.mkdirSync(home,{recursive:true});
// Exercise the installed native SQLite module and schema on disposable data.
// Never run providers, access GitHub, or migrate the live database here.
const probe=fs.mkdtempSync(path.join(home,'.installation-check-'));
try{
 const database=path.join(probe,'factory.db');
 if(process.argv[2])fs.copyFileSync(path.resolve(process.argv[2]),database);
 const {Store}=await import('../dist/src/storage.js');
 const store=new Store(database);
 try{
  const result=store.db.pragma('quick_check',{simple:true});
  if(result!=='ok')throw new Error(`SQLite integrity check failed: ${result}`);
  store.db.exec('CREATE TABLE installation_probe(value TEXT); INSERT INTO installation_probe VALUES (\'ok\');');
 }finally{store.db.close();}
 const cli=spawnSync(process.execPath,[path.join(engine,'dist/src/cli.js'),'--help'],{encoding:'utf8',timeout:15000});
 if(cli.status!==0)throw new Error(`Installed CLI cannot load: ${cli.stderr||cli.error?.message||cli.status}`);
 console.log('Installation checks passed: runtime, build assets, writable storage, SQLite/schema and CLI loading.');
}finally{fs.rmSync(probe,{recursive:true,force:true});}

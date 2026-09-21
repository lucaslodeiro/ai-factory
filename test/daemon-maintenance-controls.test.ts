import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {Store} from '../src/storage.js';
import {WorkflowMaintenance} from '../src/workflow-maintenance.js';
const source=fs.readFileSync(new URL('../src/daemon.ts',import.meta.url),'utf8');
const controlSource=source.slice(source.indexOf(' const remoteControlIds='),source.indexOf(' const sigint='));
for(const mode of ['standby','uncertain','fenced'])test(`local update maintenance works in ${mode} without enabling workflow controls`,async()=>{
 const store=new Store(':memory:');
 try{
  const maintenance=new WorkflowMaintenance(store,{isRunning:()=>false} as any);
  const plan=maintenance.request('update','dashboard');
  store.request('maintenance-confirm',plan.id);store.request('maintenance-resume',plan.id);
  let resumed=false;
  const context=vm.createContext({store,maintenance:{confirm:(id:string)=>maintenance.confirm(id),resume:()=>{resumed=true;}},controllerMode:mode,reconcileUpdateMaintenanceFile(){},path:{join:()=>''},factoryHome:()=>'',audit(){}});
  vm.runInContext(ts.transpile(controlSource),context);await vm.runInContext('controls()',context);
  assert.equal((store.db.prepare('SELECT status FROM maintenance_operations WHERE id=?').get(plan.id) as any).status,'ready');
  assert.equal(resumed,false);
  assert.equal((store.db.prepare("SELECT COUNT(*) n FROM events WHERE type='control.failed'").get() as any).n,1);
 }finally{store.db.close();}
});

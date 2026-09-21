import fs from 'node:fs';
import {config} from './config.js';
import {Worker} from 'node:worker_threads';
import type {GitHubPort,WorkflowGitHubPort} from './adapters/github.js';
type AsyncCompatible<T> = {[K in keyof T]:T[K] extends (...args:infer A)=>infer R ? (...args:A)=>R|Promise<R>:T[K]};
export type RuntimeGitHub = AsyncCompatible<GitHubPort & WorkflowGitHubPort>;
/** Only subprocess I/O moves off-thread. Workflow state stays on the daemon thread. */
export function backgroundGitHub():{github:RuntimeGitHub;close:()=>Promise<number>} {
 let worker:Worker|undefined,closed=false,sequence=0,tail:Promise<unknown>=Promise.resolve();
 const pending=new Map<number,{resolve:(value:any)=>void;reject:(error:Error)=>void}>();
 function start(){
  if(closed)throw new Error('GitHub worker stopped');
  if(worker)return worker;
  const compiled=new URL('./github-worker.js',import.meta.url),source=new URL('./github-worker.ts',import.meta.url),workerData={repo:config.repo,defaultBranch:config.defaultBranch};
  const current=fs.existsSync(compiled)?new Worker(compiled,{workerData}):new Worker(`import('tsx/esm/api').then(({tsImport})=>tsImport(${JSON.stringify(source.href)},${JSON.stringify(import.meta.url)}))`,{eval:true,workerData});
  worker=current;
  const fail=(error:Error)=>{if(worker!==current)return;worker=undefined;for(const request of pending.values())request.reject(error);pending.clear();};
  current.on('error',fail);current.on('exit',code=>fail(new Error(`GitHub worker stopped (${code})`)));
  current.on('message',({id,value,error})=>{const request=pending.get(id);if(!request)return;pending.delete(id);if(error)request.reject(new Error(error));else request.resolve(value);});
  return current;
 }
 const methods=new Set(['pullRequestState','listManaged','issue','comments','repository','repositoryComments','repositoryIssues','ensurePR','syncWorkflow','publishWorkflowComment','assignees','assign','unassign']);
 const github=new Proxy({}, {get(_target,method){
  if(typeof method!=='string'||!methods.has(method))return undefined;
  return (...args:unknown[])=>{
   const result=tail.then(()=>new Promise((resolve,reject)=>{
    try{const target=start(),id=++sequence;pending.set(id,{resolve,reject});target.postMessage({id,method,args});}catch(error){reject(error);}
   }));
   tail=result.catch(()=>{});return result;
  };
 }}) as RuntimeGitHub;
 return{github,close:async()=>{closed=true;return worker?worker.terminate():0;}};
}

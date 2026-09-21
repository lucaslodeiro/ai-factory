import {config} from './config.js';
import {parentPort,workerData} from 'node:worker_threads';
import {GitHubAdapter} from './adapters/github.js';
config.repo=workerData.repo;config.defaultBranch=workerData.defaultBranch;
const adapter=new GitHubAdapter();
const allowed=new Set(['pullRequestState','authenticatedLogin','assignedIssues','issue','comments','repository','ensureLabel','addLabel','removeLabel','replaceInstanceLabel','ensurePR','syncWorkflow','publishWorkflowComment','editComment','assignees','assign','unassign']);
parentPort?.on('message',({id,method,args})=>{try{if(!allowed.has(method))throw new Error('Unknown GitHub operation');const value=(adapter[method as keyof GitHubAdapter] as (...args:any[])=>unknown).apply(adapter,args);parentPort!.postMessage({id,value});}catch(error){parentPort!.postMessage({id,error:error instanceof Error?error.message:String(error)});}});

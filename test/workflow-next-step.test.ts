import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/storage.js';
import {WorkflowRecords} from '../src/workflow-records.js';
import {workflowNextStep} from '../src/workflow-next-step.js';
import {WorkflowGitHubPublisher} from '../src/workflow-github.js';
import {workflowStatusMarkdown} from '../src/workflow-status.js';
test('pending merge exposes its PR and next action before status history',async()=>{
 const store=new Store(':memory:');try{store.setMetadata('repository_identity',{id:1,nodeId:'R_1',fullName:'owner/demo'});
 const pr='https://github.com/owner/demo/pull/3';
 store.db.prepare("INSERT INTO work_items(id,issue_number,issue_id,repo,branch,base_branch,created_at,updated_at,context,stage,status) VALUES('w',2,200,'owner/demo','factory/issue-2','main','now','now',?,'DELIVERY','WAITING')").run(JSON.stringify({pr,title:'Portal',issueNodeId:'I_200'}));
 const records=new WorkflowRecords(store);records.create({workItemId:'w',specVersion:1,scope:'spec',payload:{kind:'request',type:'merge',owner:'human',originatingStage:'DELIVERY',allowedReturnStages:['DELIVERY'],openedAfterCommentId:0},sourceType:'orchestrator',sourceId:'delivery',actor:'orchestrator'});
 const next=workflowNextStep(store,'w','WAITING',pr);assert.equal(next?.url,pr);assert.match(next!.title,/ready for your review/);assert.equal(next?.command,'/factory answer <changes>');assert.equal(next?.respondLabel,'Request changes');assert.equal('description' in next!,false);
 for(const status of ['FAILED','PAUSED','COMPLETED','QUEUED'])assert.equal(workflowNextStep(store,'w',status,pr),null);
 assert.equal(workflowNextStep(store,'w','WAITING','javascript:alert(1)')?.url,null);
 const markdown=workflowStatusMarkdown(store,'w');assert.ok(markdown.indexOf('## Next action')<markdown.indexOf('| Detail'));assert.match(markdown,/\[Open pull request\]\(https:\/\/github.com\/owner\/demo\/pull\/3\)/);assert.equal(markdown.split('## Next action').length,2);
 store.db.prepare('UPDATE work_items SET published_presentation_revision=presentation_revision').run();
 let published=0;const publisher=new WorkflowGitHubPublisher(store,{syncWorkflow(){published++},publishWorkflowComment(){},assignees(){return[]},assign(){},unassign(){}});
 await publisher.publishChanged();assert.equal(published,0,'opening a publisher must not migrate existing comments');
 store.db.prepare('UPDATE work_items SET presentation_revision=presentation_revision+1').run();
 await publisher.publishChanged();assert.equal(published,1);await publisher.publishChanged();assert.equal(published,1);

 }finally{store.db.close()}
});

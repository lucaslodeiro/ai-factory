import type { AgentRole, Criterion, TaskAssessment } from "./types.js";
import type { Store } from "./storage.js";
import { WorkflowFailures } from "./workflow-failures.js";
import { WorkflowRecords, type WorkflowRecord } from "./workflow-records.js";

export class InvalidContextError extends Error {
  readonly failureClass = "invalid-context";
}

export interface ContextAssemblyInput {
  workItemId:string;
  role:AgentRole;
  specVersion:number;
  budgetBytes:number;
  budgetSource:string;
  issue:{title:string;body:string};
  changedFiles?:string[];
  diffStat?:string;
  diffPath?:string;
  qaEvidence?:unknown;
}

export interface ContextManifest {
  includedRecordIds:string[];
  activeRequestId?:string;
  sectionBytes:Record<string,number>;
  excludedSections:string[];
  budgetBytes:number;
  budgetSource:string;
}

export interface AssembledContext {
  markdown:string;
  manifest:ContextManifest;
}

interface Section { name:string; value:unknown; protected:boolean; }
type SpecRow={body:string;criteria:string;assessment:string|null};

const bytes=(value:string)=>Buffer.byteLength(value,"utf8");
const shortIssue=(issue:ContextAssemblyInput["issue"])=>({title:issue.title,body:issue.body.slice(0,2048),bodyTruncated:bytes(issue.body)>bytes(issue.body.slice(0,2048))});
const payload=(record:WorkflowRecord)=>({id:record.id,sequence:record.sequence,createdAt:record.createdAt,...record.payload});

function render(sections:Section[]) {
  return sections.map(section=>`## ${section.name}\n\n${JSON.stringify(section.value,null,2)}`).join("\n\n");
}

export class ContextAssembler {
  private records:WorkflowRecords;
  private failures:WorkflowFailures;
  constructor(private store:Store) { this.records=new WorkflowRecords(store);this.failures=new WorkflowFailures(store); }

  assemble(input:ContextAssemblyInput):AssembledContext {
    if (!Number.isSafeInteger(input.budgetBytes) || input.budgetBytes < 1) throw new Error("Context budget must be a positive integer");
    const item=this.store.db.prepare("SELECT id FROM work_items WHERE id=?").get(input.workItemId);
    if (!item) throw new Error("Unknown work item");
    const spec=this.store.db.prepare("SELECT body,criteria,assessment FROM specs WHERE work_item_id=? AND version=?").get(input.workItemId,input.specVersion) as SpecRow|undefined;
    if (input.role !== "product-architect" && !spec) throw new InvalidContextError(`Approved SPEC v${input.specVersion} is unavailable`);

    const active=this.records.active(input.workItemId,input.specVersion,input.role);
    const instructions=active.filter(record=>record.payload.kind === "instruction");
    const decisions=active.filter(record=>record.payload.kind === "decision");
    const findings=active.filter(record=>record.payload.kind === "finding");
    const requestChain=input.role === "product-architect" ? this.records.requestChain(input.workItemId) : [];
    const activeRequest=requestChain.at(-1);
    const activeFailure=this.failures.active(input.workItemId);
    const openFindings=this.findingsForRole(input.role,findings,requestChain);
    const issue=["product-architect","developer"].includes(input.role) ? input.issue : shortIssue(input.issue);
    const specification=spec ? {version:input.specVersion,body:spec.body,criteria:this.json<Criterion[]>(spec.criteria,[]),assessment:this.json<TaskAssessment|null>(spec.assessment,null)} : {version:0,body:null,criteria:[],assessment:null};

    const sections:Section[]=[
      {name:"Issue",value:issue,protected:true},
      {name:"Approved specification",value:specification,protected:true},
      {name:"Active human decisions",value:decisions.filter(record=>record.payload.kind === "decision" && record.payload.category === "human").map(payload),protected:true},
      {name:"Active tactical decisions",value:decisions.filter(record=>record.payload.kind === "decision" && record.payload.category === "tactical").map(payload),protected:true},
      {name:"Active instructions",value:instructions.map(payload),protected:true},
      ...(input.role === "product-architect" ? [{name:"Active request chain",value:requestChain.map(payload),protected:true}] : []),
      {name:"Open findings required by this role",value:openFindings.map(payload),protected:true},
      ...(activeFailure ? [{name:"Active failure",value:activeFailure,protected:true}] : []),
      ...(["developer","qa","reviewer"].includes(input.role) && (input.changedFiles || input.diffStat) ? [{name:"Changed files",value:{files:input.changedFiles??[],diffStat:input.diffStat??"",...(input.role==="reviewer"&&input.diffPath?{diffPath:input.diffPath}:{})},protected:false}] : []),
      ...(input.role === "reviewer" && input.qaEvidence ? [{name:"Tester execution evidence",value:input.qaEvidence,protected:false}] : []),
    ];
    const protectedSections=sections.filter(section=>section.protected);
    const protectedMarkdown=render(protectedSections);
    if (bytes(protectedMarkdown)>input.budgetBytes) throw new InvalidContextError(`Protected context requires ${bytes(protectedMarkdown)} bytes but the budget is ${input.budgetBytes}`);
    const included=[...protectedSections],excluded:string[]=[];
    for (const section of sections.filter(section=>!section.protected)) {
      const candidate=render([...included,section]);
      if (bytes(candidate)<=input.budgetBytes) included.push(section); else excluded.push(section.name);
    }
    const markdown=render(included),sectionBytes=Object.fromEntries(included.map(section=>[section.name,bytes(render([section]))]));
    return {markdown,manifest:{includedRecordIds:[...instructions,...decisions,...openFindings,...requestChain].map(record=>record.id).filter((id,index,all)=>all.indexOf(id)===index),activeRequestId:activeRequest?.id,sectionBytes,excludedSections:excluded,budgetBytes:input.budgetBytes,budgetSource:input.budgetSource}};
  }

  private findingsForRole(role:AgentRole,findings:WorkflowRecord[],requestChain:WorkflowRecord[]) {
    if (role === "developer") return findings.filter(record=>record.payload.kind === "finding" && record.payload.classification === "auto-fix");
    if (role === "product-architect") {
      const ids=new Set(requestChain.flatMap(record=>record.payload.kind === "request" ? record.payload.findingIds??[] : []));
      return findings.filter(record=>record.payload.kind === "finding" && (record.payload.classification === "decision-required" || ids.has(record.id)));
    }
    if (role === "reviewer") return findings.map(record=>record.payload.kind === "finding" ? ({...record,payload:{...record.payload,evidence:"Omitted; inspect the repository independently."}} as WorkflowRecord) : record);
    return [];
  }

  private json<T>(value:string|null,fallback:T):T { if (!value) return fallback;try{return JSON.parse(value) as T;}catch{throw new InvalidContextError("Stored specification context is invalid JSON");} }
}

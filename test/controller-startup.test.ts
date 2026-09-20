import test from "node:test";
import assert from "node:assert/strict";
import {runControllerCycle} from "../src/daemon.js";
import type {LeaseObservation} from "../src/controller-lease.js";

const instance={schemaVersion:1 as const,instanceId:"11111111-1111-4111-8111-111111111111",displayName:"Factory 111111",createdAt:"2026-09-21T00:00:00.000Z"};
const record={schemaVersion:1 as const,repositoryId:1,repositoryNodeId:"R_1",instanceId:"22222222-2222-4222-8222-222222222222",displayName:"Factory 222222",contact:"",generation:2,engineVersion:"0.2.0",acquiredAt:"2026-09-21T00:00:00.000Z",heartbeatAt:"2026-09-21T00:01:00.000Z",activeWorkCount:1};

test("standby controller cycle performs no polling, scheduling or publication",async()=>{
 let ticks=0;const orchestrator={tick:async()=>{ticks++;}},standby={state:"standby",sha:"a".repeat(40),record,expiresAt:"2026-09-21T00:11:00.000Z",heartbeatAgeMs:1,instance} satisfies LeaseObservation;
 assert.equal(await runControllerCycle(standby,orchestrator as any),false);assert.equal(ticks,0);
 const active={...standby,state:"active" as const,record:{...record,instanceId:instance.instanceId}};
 assert.equal(await runControllerCycle(active,orchestrator as any),true);assert.equal(ticks,1);
});

import test from "node:test";
import assert from "node:assert/strict";
import { parseFactoryCommand } from "../src/factory-command.js";

test("parses lifecycle commands strictly",()=>{
 assert.throws(()=>parseFactoryCommand("/factory start"),/malformed/);
 assert.deepEqual(parseFactoryCommand("/factory help\nThanks"),{kind:"help"});
 assert.deepEqual(parseFactoryCommand("/factory approve v12"),{kind:"approve",version:12,guidance:""});
 assert.deepEqual(parseFactoryCommand("/factory cancel"),{kind:"cancel",reason:""});
 assert.deepEqual(parseFactoryCommand("/factory pause"),{kind:"pause",reason:""});
 assert.deepEqual(parseFactoryCommand("/factory revoke abc-123"),{kind:"revoke",recordId:"abc-123"});
 assert.deepEqual(parseFactoryCommand("/factory revoke #2"),{kind:"revoke",recordId:"#2"});
 assert.deepEqual(parseFactoryCommand("/factory cancel\nThanks"),{kind:"cancel",reason:"Thanks"});
 assert.deepEqual(parseFactoryCommand("/factory approve v12\nLooks good"),{kind:"approve",version:12,guidance:"Looks good"});
 assert.equal(parseFactoryCommand("Please /factory start"),null);
 assert.equal(parseFactoryCommand("> /factory retry"),null);
 assert.deepEqual(parseFactoryCommand("Please retry this\n/factory retry"),{kind:"retry",guidance:"Please retry this",scope:"spec",appliesTo:[]});
 assert.throws(()=>parseFactoryCommand("/factory approve 12"),/malformed/);
});

test("commands may be the first or last non-empty line with all other lines as payload",()=>{
 assert.throws(()=>parseFactoryCommand("Let's go\n/factory start"),/malformed/);
 assert.throws(()=>parseFactoryCommand("/factory start\nLet's go"),/malformed/);
 assert.deepEqual(parseFactoryCommand("Looks good\n/factory approve v2"),{kind:"approve",version:2,guidance:"Looks good"});
 assert.deepEqual(parseFactoryCommand("Here is my answer\n/factory answer"),{kind:"answer",text:"Here is my answer"});
 assert.deepEqual(parseFactoryCommand("/factory retry\nuse WebKit"),parseFactoryCommand("use WebKit\n/factory retry"));
 assert.deepEqual(parseFactoryCommand("/factory pause\n/factory cancel"),{kind:"pause",reason:"/factory cancel"});
 assert.equal(parseFactoryCommand("thanks\n/factory retry\nmore text"),null);
 assert.equal(parseFactoryCommand("> /factory retry"),null);
});

test("answer and retry accept inline or following multiline guidance",()=>{
 assert.deepEqual(parseFactoryCommand("/factory answer\nUse SQLite.\nKeep it local."),{kind:"answer",text:"Use SQLite.\nKeep it local."});
 assert.deepEqual(parseFactoryCommand("/factory retry Retry without Chromium"),{kind:"retry",guidance:"Retry without Chromium",scope:"spec",appliesTo:[]});
 assert.deepEqual(parseFactoryCommand("/factory retry"),{kind:"retry",guidance:"",scope:"spec",appliesTo:[]});
 assert.deepEqual(parseFactoryCommand("/factory retry --issue --for builder,tester Keep the API stable"),{kind:"retry",guidance:"Keep the API stable",scope:"issue",appliesTo:["developer","qa"]});
 assert.throws(()=>parseFactoryCommand("/factory start Prefer a small dependency-free design"),/malformed/);
 assert.deepEqual(parseFactoryCommand("/factory pause Waiting for legal review"),{kind:"pause",reason:"Waiting for legal review"});
});

test("note and replace parse scope and human-facing role aliases",()=>{
 assert.deepEqual(parseFactoryCommand("/factory note --issue --for builder,tester Never expose the token"),{kind:"note",scope:"issue",appliesTo:["developer","qa"],text:"Never expose the token"});
 assert.deepEqual(parseFactoryCommand("/factory replace 1234 --for reviewer\nRequire an independent security review"),{kind:"replace",recordId:"1234",scope:"spec",appliesTo:["reviewer"],text:"Require an independent security review"});
 assert.deepEqual(parseFactoryCommand("/factory replace #2 Use WebKit"),{kind:"replace",recordId:"#2",scope:"spec",appliesTo:[],text:"Use WebKit"});
 assert.throws(()=>parseFactoryCommand("/factory note --for manager Do it"),/Unknown role manager/);
 assert.throws(()=>parseFactoryCommand("/factory replace abc"),/requires replacement text/);
});

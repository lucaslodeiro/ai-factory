import test from "node:test";
import assert from "node:assert/strict";
import { parseFactoryCommand } from "../src/factory-command.js";

test("parses lifecycle commands strictly",()=>{
 assert.deepEqual(parseFactoryCommand("/factory start"),{kind:"start",guidance:""});
 assert.deepEqual(parseFactoryCommand("/factory help\nThanks"),{kind:"help"});
 assert.deepEqual(parseFactoryCommand("/factory approve v12"),{kind:"approve",version:12,guidance:""});
 assert.deepEqual(parseFactoryCommand("/factory cancel"),{kind:"cancel",reason:""});
 assert.deepEqual(parseFactoryCommand("/factory pause"),{kind:"pause",reason:""});
 assert.deepEqual(parseFactoryCommand("/factory revoke abc-123"),{kind:"revoke",recordId:"abc-123"});
 assert.deepEqual(parseFactoryCommand("/factory cancel\nThanks"),{kind:"cancel",reason:"Thanks"});
 assert.deepEqual(parseFactoryCommand("/factory approve v12\nLooks good"),{kind:"approve",version:12,guidance:"Looks good"});
 assert.equal(parseFactoryCommand("Please /factory start"),null);
 assert.equal(parseFactoryCommand("> /factory retry"),null);
 assert.equal(parseFactoryCommand("Please retry this\n/factory retry"),null);
 assert.throws(()=>parseFactoryCommand("/factory approve 12"),/malformed/);
});

test("answer and retry accept inline or following multiline guidance",()=>{
 assert.deepEqual(parseFactoryCommand("/factory answer\nUse SQLite.\nKeep it local."),{kind:"answer",text:"Use SQLite.\nKeep it local."});
 assert.deepEqual(parseFactoryCommand("/factory retry Retry without Chromium"),{kind:"retry",guidance:"Retry without Chromium",scope:"spec",appliesTo:[]});
 assert.deepEqual(parseFactoryCommand("/factory retry"),{kind:"retry",guidance:"",scope:"spec",appliesTo:[]});
 assert.deepEqual(parseFactoryCommand("/factory retry --issue --for builder,tester Keep the API stable"),{kind:"retry",guidance:"Keep the API stable",scope:"issue",appliesTo:["developer","qa"]});
 assert.deepEqual(parseFactoryCommand("/factory start Prefer a small dependency-free design"),{kind:"start",guidance:"Prefer a small dependency-free design"});
 assert.deepEqual(parseFactoryCommand("/factory pause Waiting for legal review"),{kind:"pause",reason:"Waiting for legal review"});
});

test("note and replace parse scope and human-facing role aliases",()=>{
 assert.deepEqual(parseFactoryCommand("/factory note --issue --for builder,tester Never expose the token"),{kind:"note",scope:"issue",appliesTo:["developer","qa"],text:"Never expose the token"});
 assert.deepEqual(parseFactoryCommand("/factory replace 1234 --for reviewer\nRequire an independent security review"),{kind:"replace",recordId:"1234",scope:"spec",appliesTo:["reviewer"],text:"Require an independent security review"});
 assert.throws(()=>parseFactoryCommand("/factory note --for manager Do it"),/Unknown role manager/);
 assert.throws(()=>parseFactoryCommand("/factory replace abc"),/requires replacement text/);
});

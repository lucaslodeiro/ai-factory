import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {codexModelOptions} from "../src/dashboard-settings.js";
import {availableCursorModels,parseCursorModelList} from "../src/dashboard-credentials.js";

test("Codex suggests the visible models in its local CLI cache",()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"factory-models-"));try{
  const file=path.join(root,"models_cache.json");fs.writeFileSync(file,JSON.stringify({models:[{slug:"gpt-6-astra",visibility:"list"},{slug:"gpt-6-sol",visibility:"list"},{slug:"internal-model",visibility:"hide"}]}));
  assert.deepEqual(codexModelOptions(file).map(option=>option.value),["auto","gpt-6-astra","gpt-6-sol"]);
  assert.ok(codexModelOptions(path.join(root,"missing")).some(option=>option.value==="gpt-5.6-luna"));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test("Cursor suggestions come from the account's CLI list, not a fixed catalog",async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"factory-cursor-models-"));try{
  const command=path.join(root,"cursor-agent");fs.writeFileSync(command,"#!/bin/sh\nprintf 'Available models:\\n  gpt-6-sol - GPT-6 Sol\\n  claude-sonnet-5 - Sonnet 5\\n'\n",{mode:0o755});
  assert.deepEqual(parseCursorModelList("Available models:\n  gpt-6-sol - GPT-6 Sol\n"),["gpt-6-sol"]);
  assert.deepEqual(await availableCursorModels(root,command),["gpt-6-sol","claude-sonnet-5"]);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

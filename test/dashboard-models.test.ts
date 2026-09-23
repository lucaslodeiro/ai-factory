import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {readDashboardSettings} from "../src/dashboard-settings.js";
import {availableCursorModels,parseCursorModelList} from "../src/dashboard-credentials.js";

test("every provider has a curated model catalog with Auto exactly once",()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"factory-models-"));try{
  fs.copyFileSync(new URL("../.env.example",import.meta.url),path.join(root,".env.example"));
  const catalog=readDashboardSettings(root).modelCatalog;
  assert.deepEqual(catalog.codex.options.map(option=>option.value),["auto","gpt-6-astra","gpt-6-sol","gpt-6-luna","gpt-5.6-sol","gpt-5.6-terra","gpt-5.6-luna","gpt-5.5"]);
  assert.deepEqual(catalog.claude.options.map(option=>option.value),["auto","fable","opus","sonnet","haiku"]);
  assert.deepEqual(catalog.cursor.options.map(option=>option.value),["auto","composer-2.5","gpt-5","sonnet-4-thinking"]);
  for(const provider of Object.values(catalog))assert.equal(provider.options.filter(option=>option.value==="auto").length,1);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test("Cursor suggestions come from the account's CLI list, not a fixed catalog",async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"factory-cursor-models-"));try{
  const command=path.join(root,"cursor-agent");fs.writeFileSync(command,"#!/bin/sh\nprintf 'Available models:\\n  gpt-6-sol - GPT-6 Sol\\n  claude-sonnet-5 - Sonnet 5\\n'\n",{mode:0o755});
  assert.deepEqual(parseCursorModelList("Available models:\n  gpt-6-sol - GPT-6 Sol\n"),["gpt-6-sol"]);
  assert.deepEqual(await availableCursorModels(root,command),["gpt-6-sol","claude-sonnet-5"]);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

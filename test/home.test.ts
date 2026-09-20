import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { factoryHome } from "../src/home.js";

test("factory home uses the explicit environment override",()=>{
  assert.equal(factoryHome("/tmp/install/engine",{AI_FACTORY_HOME:"/tmp/custom"}),path.resolve("/tmp/custom"));
});
test("factory home is the parent of an installed engine directory",()=>{
  assert.equal(factoryHome("/tmp/install/engine",{}),path.resolve("/tmp/install"));
});
test("factory home is a developer checkout when its name is not engine",()=>{
  assert.equal(factoryHome("/tmp/ai-factory",{}),path.resolve("/tmp/ai-factory"));
});

import test from "node:test";
import assert from "node:assert/strict";
import {normalizeInstanceName} from "../src/config.js";

test("instance names are label-safe, bounded and never empty",()=>{
 assert.equal(normalizeInstanceName("AI's MacBook Pro.local"),"ai-s-macbook-pro-local");
 assert.equal(normalizeInstanceName("x".repeat(80)),"x".repeat(40));
 assert.equal(normalizeInstanceName("___"),"factory");
});

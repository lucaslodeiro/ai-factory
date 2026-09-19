import test from "node:test";
import assert from "node:assert/strict";
import { extractTokenUsage } from "../src/token-usage.js";

test("extracts reported Codex and Claude token usage without estimating missing fields", () => {
 assert.deepEqual(extractTokenUsage("codex","","progress\ntokens used\n44,338\n"),{inputTokens:null,outputTokens:null,cachedTokens:null,totalTokens:44338});
 assert.deepEqual(extractTokenUsage("claude",JSON.stringify({usage:{input_tokens:100,output_tokens:25,cache_creation_input_tokens:10,cache_read_input_tokens:15}}),""),
  {inputTokens:100,outputTokens:25,cachedTokens:25,totalTokens:150});
 assert.equal(extractTokenUsage("codex","no usage", ""),null);
});

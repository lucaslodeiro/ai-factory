import test from "node:test";
import assert from "node:assert/strict";
import { resolveContextBudget } from "../src/context-budget.js";

const settings={defaultBytes:200000,overrides:{developer:150000,"codex/gpt-6-astra":300000,"qa":125000}};

test("context budget precedence is provider/model, role, then default",()=>{
  assert.deepEqual(resolveContextBudget("developer",{provider:"codex",model:"gpt-6-astra"},settings),{bytes:300000,source:"provider/model:codex/gpt-6-astra"});
  assert.deepEqual(resolveContextBudget("developer",{provider:"codex",model:"gpt-5.6-terra"},settings),{bytes:150000,source:"role:developer"});
  assert.deepEqual(resolveContextBudget("reviewer",{provider:"claude",model:"sonnet"},settings),{bytes:200000,source:"default"});
});

test("auto never uses a provider/model override",()=>{
  const auto={defaultBytes:200000,overrides:{"codex/auto":999999,qa:125000}};
  assert.deepEqual(resolveContextBudget("qa",{provider:"codex",model:"auto"},auto),{bytes:125000,source:"role:qa"});
});

import test from "node:test";
import assert from "node:assert/strict";
import { publicNaming, roleFullName, roleShortName, roleStageName, stateName } from "../src/names.js";

test("agent names consistently expose full role, short name and workflow stage", () => {
  assert.deepEqual(publicNaming.roles, {
    "product-architect": { full:"Product Architect", short:"Architect", stage:"Design" },
    developer: { full:"Implementation Engineer", short:"Builder", stage:"Build" },
    qa: { full:"Verification Engineer", short:"Tester", stage:"Test" },
    reviewer: { full:"Delivery Reviewer", short:"Reviewer", stage:"Review" },
  });
  assert.equal(roleFullName("developer"),"Implementation Engineer");
  assert.equal(roleShortName("qa"),"Tester");
  assert.equal(roleStageName("reviewer"),"Review");
  assert.equal(stateName("BUILD"),"Build");
  assert.equal(stateName("TEST"),"Test");
});

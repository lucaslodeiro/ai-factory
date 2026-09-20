import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

test("dashboard explains active and standby repository control and removes standby workflow actions",()=>{const root=path.resolve(new URL("..",import.meta.url).pathname),html=fs.readFileSync(path.join(root,"dashboard/index.html"),"utf8"),app=fs.readFileSync(path.join(root,"dashboard/app.js"),"utf8");assert.match(html,/REPOSITORY CONTROLLER/);assert.match(html,/Release control/);assert.match(html,/Force takeover/);assert.match(app,/Active controller/);assert.match(app,/This installation does not process issues or modify GitHub/);assert.match(app,/Tracked here/);assert.match(app,/!standby&&\['FAILED'/);assert.match(app,/refreshButton\.disabled=standby/);});

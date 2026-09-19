import test from "node:test";
import assert from "node:assert/strict";
import { daemonLog } from "../src/logger.js";

test("daemon logger emits compact timestamped fields without multiline injection", () => {
 const lines:string[]=[]; const original=console.log; console.log=(line:string)=>lines.push(line);
 try { daemonLog("info","execution.started",{role:"developer",message:"first\nsecond",empty:undefined},"2026-09-19T12:00:00.000Z"); }
 finally { console.log=original; }
 assert.equal(lines[0],'2026-09-19T12:00:00.000Z INFO  execution.started role="developer" message="first second"');
});

import test from "node:test";
import assert from "node:assert/strict";
import { announcedRuntimeUrl } from "../src/local-runtime.js";
import { failureDiagnosis } from "../src/failure-report.js";

test("a repository that announces several origins yields its loopback one",()=>{
 // The exact shape issue 6 left behind: primary LAN address first, loopback last.
 const found=announcedRuntimeUrl("https://192.168.4.30:4330/es/\nhttps://100.77.212.98:4330/es/\nhttp://127.0.0.1:4330/es/\n");
 assert.equal(found.url,"http://127.0.0.1:4330/es/");
 assert.deepEqual(found.announced,["192.168.4.30","100.77.212.98","127.0.0.1"]);
});

test("a single loopback URL still works, with or without a trailing newline",()=>{
 assert.equal(announcedRuntimeUrl("http://127.0.0.1:64347/es/").url,"http://127.0.0.1:64347/es/");
 assert.equal(announcedRuntimeUrl("http://localhost:4321/\n").url,"http://localhost:4321/");
 assert.equal(announcedRuntimeUrl("http://[::1]:4321/").url,"http://[::1]:4321/");
});

test("only non-loopback origins is reported as such, not as an empty file",()=>{
 const found=announcedRuntimeUrl("https://192.168.4.30:4330/\nhttps://example.test/");
 assert.equal(found.url,null);
 assert.deepEqual(found.announced,["192.168.4.30","example.test"]);
});

test("an empty or unparseable file announces nothing rather than throwing",()=>{
 for (const contents of ["","   \n\n","not a url","\u0000"]) {
  const found=announcedRuntimeUrl(contents);
  assert.equal(found.url,null);
  assert.deepEqual(found.announced,[]);
 }
});

test("the runtime failures are diagnosed by name instead of reported as unknown",()=>{
 const notReady=failureDiagnosis("Could not prepare workflow execution: Factory local runtime did not become ready. See /data/local-runtimes/a4a6.log","");
 assert.match(notReady,/preview server/);
 assert.match(notReady,/a4a6\.log/);
 assert.doesNotMatch(notReady,/does not identify its underlying cause/);

 const noLoopback=failureDiagnosis("Could not prepare workflow execution: Factory local runtime announced no loopback address. `local:serve` published 192.168.4.30. See /data/x.log","");
 assert.match(noLoopback,/loopback origin/);
 assert.match(noLoopback,/192\.168\.4\.30/);
 assert.doesNotMatch(noLoopback,/does not identify its underlying cause/);
});

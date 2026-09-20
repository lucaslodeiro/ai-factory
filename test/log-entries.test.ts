import test from 'node:test';
import assert from 'node:assert/strict';
import {logEntries} from '../src/log-entries.js';
test('combines streams by timestamp and filters severity rather than output channel',()=>{
 const entries=logEntries([{exists:true,content:'2026-09-20T12:00:02Z ERROR job.failed reason="bad"\n2026-09-20T12:00:04Z INFO daemon.ready errors=0'},{exists:true,content:'2026-09-20T12:00:01Z WARN provider.slow\n2026-09-20T12:00:03Z WARN execution.finished status="failed"\nTypeError: broken\n    at run (file.js:1)'}]);
 assert.equal(entries[0].text,'2026-09-20T12:00:01Z WARN provider.slow');
 const errors=entries.filter(entry=>entry.error);assert.equal(errors.length,3);assert.match(errors[2].text,/at run/);assert.equal(entries.find(entry=>entry.text.includes('errors=0'))?.error,false);
});
test('plain stderr warnings and ordinary output are not automatically errors',()=>{assert.deepEqual(logEntries([{exists:true,content:'Warning: experimental feature\nDaemon started\nError: connection refused'}]).map(entry=>entry.error),[false,false,true]);});

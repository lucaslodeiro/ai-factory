#!/usr/bin/env node
import {Command} from "commander";
import {doctor} from "./doctor.js";
import {db} from "./storage.js";
import {ExecutionManager} from "./execution-manager.js";
import {startDaemon} from "./daemon.js";

const p=new Command().name("factory").description("Local AI Software Factory").version("0.1.0");
const executions=new ExecutionManager();
executions.recover();

p.command("doctor").action(()=>process.exitCode=doctor()?0:1);
p.command("status").argument("[id]").action(id=>console.table(id?db.prepare("SELECT * FROM work_items WHERE id=?").all(id):db.prepare("SELECT * FROM work_items ORDER BY updated_at DESC").all()));
p.command("cancel").argument("<run-id>").action(id=>{if(!executions.cancel(id)){console.error("Run is not active in this orchestrator process.");process.exitCode=1}});
p.command("retry").argument("<id>").action(id=>console.log("Retry requested for "+id+"; workflow retry routing is not implemented yet."));
p.command("start").action(async()=>startDaemon());
p.command("stop").action(()=>console.log("For the foreground MVP daemon use Ctrl-C. Persistent daemon control is not implemented yet."));
await p.parseAsync();

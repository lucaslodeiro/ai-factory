import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { config } from "./config.js";
import { notificationText } from "./notifications.js";
import { assertTransition } from "./state-machine.js";
import type { WorkItem, WorkState } from "./types.js";
export class Store {
  db: Database.Database;
  constructor(filename = path.join(config.dataDir, "factory.db")) {
    if (filename !== ":memory:") fs.mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new Database(filename);
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("journal_mode = WAL");
    // CLI and daemon can open a fresh database together: serialize all migrations.
    this.db.transaction(() => {
    this.db.exec(`CREATE TABLE IF NOT EXISTS work_items(id TEXT PRIMARY KEY,issue_number INTEGER NOT NULL,repo TEXT NOT NULL,state TEXT NOT NULL,branch TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS executions(id TEXT PRIMARY KEY,work_item_id TEXT NOT NULL,role TEXT NOT NULL,status TEXT NOT NULL,pid INTEGER,started_at TEXT NOT NULL,finished_at TEXT,exit_code INTEGER);
      CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT,ts TEXT NOT NULL,work_item_id TEXT,run_id TEXT,type TEXT NOT NULL,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox(id INTEGER PRIMARY KEY AUTOINCREMENT,issue_number INTEGER,body TEXT NOT NULL,sent INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS specs(work_item_id TEXT NOT NULL,version INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(work_item_id,version));
      CREATE TABLE IF NOT EXISTS notifications(id INTEGER PRIMARY KEY AUTOINCREMENT,body TEXT NOT NULL,sent INTEGER NOT NULL DEFAULT 0,attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL DEFAULT 0,last_error TEXT);
      CREATE TABLE IF NOT EXISTS controls(id INTEGER PRIMARY KEY AUTOINCREMENT,kind TEXT NOT NULL,target TEXT,handled INTEGER NOT NULL DEFAULT 0);
      CREATE UNIQUE INDEX IF NOT EXISTS issue_identity ON work_items(repo,issue_number);`);
    const cols = this.db.prepare("PRAGMA table_info(work_items)").all() as { name: string }[];
    if (!cols.some(c => c.name === "context")) this.db.exec("ALTER TABLE work_items ADD COLUMN context TEXT NOT NULL DEFAULT '{}'");
    for (const [table, column, type] of [["specs", "criteria", "TEXT NOT NULL DEFAULT '[]'"], ["executions", "recovery_pending", "INTEGER NOT NULL DEFAULT 0"]]) {
      const existing = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
      if (!existing.some(c => c.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
    }).immediate();
  }
  items(): WorkItem[] { return (this.db.prepare("SELECT * FROM work_items ORDER BY created_at").all() as any[]).map(r => ({ ...r, context: JSON.parse(r.context) })); }
  get(id: string) { return this.items().find(w => w.id === id); }
  save(w: WorkItem) {
    this.db.prepare("UPDATE work_items SET state=?,branch=?,context=?,updated_at=? WHERE id=?")
      .run(w.state, w.branch, JSON.stringify(w.context), new Date().toISOString(), w.id);
  }
  transition(w: WorkItem, to: WorkState) {
    assertTransition(w.state, to);
    this.db.transaction(() => { const from = w.state; w.state = to; this.save(w); this.event("state.changed", { from, to }, w.id); this.notify(w); })();
  }
  event(type: string, payload: unknown, workItemId?: string, runId?: string) {
    this.db.prepare("INSERT INTO events(ts,work_item_id,run_id,type,payload) VALUES(?,?,?,?,?)")
      .run(new Date().toISOString(), workItemId ?? null, runId ?? null, type, JSON.stringify(payload));
  }
  notify(w: WorkItem, detail?: string) { this.db.prepare("INSERT INTO notifications(body) VALUES(?)").run(notificationText(w, detail)); }
  post(issue: number, body: string) {
    for (let offset = 0; offset < body.length; offset += 25000) this.db.prepare("INSERT INTO outbox(issue_number,body) VALUES(?,?)").run(issue, body.slice(offset, offset + 25000));
  }
  request(kind: string, target = "") { this.db.prepare("INSERT INTO controls(kind,target) VALUES(?,?)").run(kind, target); }
}

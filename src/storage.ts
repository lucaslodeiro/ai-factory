import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { config } from "./config.js";
export const schemaVersion=6;
export class Store {
  db: Database.Database;
  constructor(filename = path.join(config.dataDir, "factory.db")) {
    if (filename !== ":memory:") fs.mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new Database(filename);
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("foreign_keys = ON");
    const existingTables=(this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as Array<{name:string}>).map(row=>row.name);
    if(existingTables.length){
      const stored=existingTables.includes("metadata")?this.db.prepare("SELECT value FROM metadata WHERE key='schema_version'").get() as {value:string}|undefined:undefined;
      let version:unknown;try{version=stored?JSON.parse(stored.value):undefined;}catch{version=undefined;}
      if(version!==schemaVersion){this.db.close();throw new Error("Unsupported AI Factory database schema. The completed V3 runtime requires a fresh data directory. Stop services and run the supported uninstaller, or select an empty FACTORY_DATA_DIR. Existing data was not changed.");}
    }
    this.db.pragma("journal_mode = WAL");
    // CLI and daemon can open a fresh database together: serialize schema creation.
    try { this.db.transaction(() => {
    const tables=(this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as Array<{name:string}>).map(row=>row.name);
    const metadataExists=tables.includes("metadata");
    const stored=metadataExists ? this.db.prepare("SELECT value FROM metadata WHERE key='schema_version'").get() as {value:string}|undefined : undefined;
    let version:unknown;
    try { version=stored ? JSON.parse(stored.value) : undefined; } catch { version=undefined; }
    if (tables.length && version !== schemaVersion) throw new Error("Unsupported AI Factory database schema. The completed V3 runtime requires a fresh data directory. Stop services and run the supported uninstaller, or select an empty FACTORY_DATA_DIR. Existing data was not changed.");
    // Retired coordination cache: safe for existing schema-6 databases and
    // serialized with schema initialization. Workflow/audit data is untouched.
    this.db.exec("DROP TABLE IF EXISTS repository_controller");
    this.db.exec(`CREATE TABLE IF NOT EXISTS work_items(
        id TEXT PRIMARY KEY,issue_number INTEGER NOT NULL,issue_id INTEGER,issue_node_id TEXT,issue_created_at TEXT,repo TEXT NOT NULL,branch TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
        context TEXT NOT NULL DEFAULT '{}',stage TEXT,status TEXT,attempt INTEGER NOT NULL DEFAULT 0,revision INTEGER NOT NULL DEFAULT 0,
        presentation_revision INTEGER NOT NULL DEFAULT 0,published_presentation_revision INTEGER,active_run_id TEXT,active_request_id TEXT,
        active_failure_id TEXT,correction_cycles INTEGER NOT NULL DEFAULT 0,archived_at TEXT
      );
      CREATE TABLE IF NOT EXISTS executions(
        id TEXT PRIMARY KEY,work_item_id TEXT NOT NULL,role TEXT NOT NULL,status TEXT NOT NULL,pid INTEGER,started_at TEXT NOT NULL,finished_at TEXT,exit_code INTEGER,
        recovery_pending INTEGER NOT NULL DEFAULT 0,stage TEXT,input_tokens INTEGER,output_tokens INTEGER,cached_tokens INTEGER,total_tokens INTEGER,
        prompt_bytes INTEGER,prompt_sha256 TEXT,interruption_reason TEXT,maintenance_id TEXT
      );
      CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT,ts TEXT NOT NULL,work_item_id TEXT,run_id TEXT,type TEXT NOT NULL,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS specs(work_item_id TEXT NOT NULL,version INTEGER NOT NULL,body TEXT NOT NULL,criteria TEXT NOT NULL DEFAULT '[]',assessment TEXT,approved_by TEXT,approval_comment_id INTEGER,approved_at TEXT,PRIMARY KEY(work_item_id,version));
      CREATE TABLE IF NOT EXISTS notifications(id INTEGER PRIMARY KEY AUTOINCREMENT,body TEXT NOT NULL,work_item_id TEXT,sent INTEGER NOT NULL DEFAULT 0,attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL DEFAULT 0,last_error TEXT);
      CREATE TABLE IF NOT EXISTS controls(id INTEGER PRIMARY KEY AUTOINCREMENT,kind TEXT NOT NULL,target TEXT,handled INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS issue_identity ON work_items(repo,issue_number) WHERE archived_at IS NULL;`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS records(
        id TEXT PRIMARY KEY,
        work_item_id TEXT NOT NULL REFERENCES work_items(id),
        sequence INTEGER NOT NULL,
        kind TEXT NOT NULL,
        spec_version INTEGER NOT NULL,
        scope TEXT NOT NULL,
        status TEXT NOT NULL,
        applies_to TEXT NOT NULL DEFAULT '[]',
        payload TEXT NOT NULL,
        source_type TEXT NOT NULL,
        source_id TEXT NOT NULL,
        actor TEXT NOT NULL,
        parent_id TEXT REFERENCES records(id),
        superseded_by TEXT REFERENCES records(id),
        resolved_by TEXT REFERENCES executions(id),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS records_active ON records(work_item_id,kind,status,spec_version);
      CREATE UNIQUE INDEX IF NOT EXISTS records_sequence ON records(work_item_id,sequence);
      CREATE TABLE IF NOT EXISTS failures(
        id TEXT PRIMARY KEY,
        work_item_id TEXT NOT NULL REFERENCES work_items(id),
        execution_id TEXT REFERENCES executions(id),
        class TEXT NOT NULL,
        message TEXT NOT NULL,
        stage TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        resolved_at TEXT,
        resolved_by TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS failures_one_open ON failures(work_item_id) WHERE resolved_at IS NULL;
      CREATE TABLE IF NOT EXISTS maintenance_operations(
        id TEXT PRIMARY KEY,
        operation TEXT NOT NULL,
        actor TEXT NOT NULL,
        status TEXT NOT NULL,
        requested_at TEXT NOT NULL,
        confirmed_at TEXT,
        finished_at TEXT,
        error TEXT
      );
      CREATE TABLE IF NOT EXISTS maintenance_items(
        maintenance_id TEXT NOT NULL REFERENCES maintenance_operations(id),
        work_item_id TEXT NOT NULL REFERENCES work_items(id),
        confirmed_revision INTEGER NOT NULL,
        paused_at TEXT,
        resumed_at TEXT,
        PRIMARY KEY(maintenance_id,work_item_id)
      );
`);
    if (!stored) this.db.prepare("INSERT INTO metadata(key,value) VALUES('schema_version',?)").run(JSON.stringify(schemaVersion));
    }).immediate(); }
    catch (error) { this.db.close();throw error; }
  }
  event(type: string, payload: unknown, workItemId?: string, runId?: string) {
    this.db.prepare("INSERT INTO events(ts,work_item_id,run_id,type,payload) VALUES(?,?,?,?,?)")
      .run(new Date().toISOString(), workItemId ?? null, runId ?? null, type, JSON.stringify(payload));
  }
  request(kind: string, target = "") { return Number(this.db.prepare("INSERT INTO controls(kind,target) VALUES(?,?)").run(kind, target).lastInsertRowid); }
  metadata<T>(key: string): T | undefined {
    const row=this.db.prepare("SELECT value FROM metadata WHERE key=?").get(key) as {value:string} | undefined;
    if (!row) return undefined;
    try { return JSON.parse(row.value) as T; } catch { return undefined; }
  }
  setMetadata(key: string,value: unknown) {
    this.db.prepare("INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key,JSON.stringify(value));
  }
}

import { cpSync } from "node:fs";
for (const dir of ["agents", "templates"]) cpSync(dir, `dist/${dir}`, { recursive: true });
cpSync("src/worker-supervisor.mjs", "dist/src/worker-supervisor.mjs");

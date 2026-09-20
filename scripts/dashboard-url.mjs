import fs from "node:fs";
import { parse } from "dotenv";
import { environmentFile } from "./paths.mjs";

const values = fs.existsSync(environmentFile) ? parse(fs.readFileSync(environmentFile,"utf8")) : {};
const host = values.FACTORY_DASHBOARD_HOST || "127.0.0.1";
const port = values.FACTORY_DASHBOARD_PORT || "4173";
process.stdout.write(`http://${host === "::1" ? "[::1]" : host}:${port}`);

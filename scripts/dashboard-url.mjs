import fs from "node:fs";
import { parse } from "dotenv";

const values = fs.existsSync(".env") ? parse(fs.readFileSync(".env","utf8")) : {};
const host = values.FACTORY_DASHBOARD_HOST || "127.0.0.1";
const port = values.FACTORY_DASHBOARD_PORT || "4173";
process.stdout.write(`http://${host === "::1" ? "[::1]" : host}:${port}`);

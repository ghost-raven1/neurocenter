import * as path from "node:path";
import * as lancedb from "@lancedb/lancedb";

const root = process.env.ASSET_SYNC_PROJECT_ROOT;
const store = process.argv[2] || process.env.ASSET_SYNC_RAG_DB || (root && path.join(root, ".opencode", "rag_db"));
if (!store) {
    console.error("Укажи store (argv[2]) или ASSET_SYNC_RAG_DB / ASSET_SYNC_PROJECT_ROOT");
    process.exit(2);
}

const db = await lancedb.connect(store);
const table = await db.openTable("chunks");
const schema = await table.schema();
console.log("=== FIELDS ===");
for (const f of schema.fields) {
  const dim = f.type && typeof f.type.listSize === "number"
    ? ` (listSize=${f.type.listSize})`
    : "";
  const typ = f.type ? String(f.type.type ?? f.type) : "unknown";
  console.log(` - ${f.name}: ${typ}${dim}`);
}
const count = await table.countRows();
console.log("=== ROWCOUNT ===", count);

const sample = await table.query().select(["id", "content"]).limit(3).toLance();
const rows = typeof sample.toArray === "function" ? sample.toArray() : [...sample];
console.log("=== SAMPLE ===");
for (const r of rows) {
  console.log(` id=${r.id} contentLen=${typeof r.content === "string" ? r.content.length : "?"}`);
}

// 导出所有契约的 JSON Schema 到 contracts/json/，保持语言无关契约。
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONTRACTS, contractJsonSchema, type ContractName } from "./index";

const outDir = join(process.cwd(), "contracts", "json");
mkdirSync(outDir, { recursive: true });

for (const name of Object.keys(CONTRACTS) as ContractName[]) {
  const schema = contractJsonSchema(name);
  writeFileSync(join(outDir, `${name}.json`), JSON.stringify(schema, null, 2));
  console.log(`exported ${name}.json`);
}

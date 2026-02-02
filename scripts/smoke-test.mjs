import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const distEntry = resolve("dist/index.js");
if (!existsSync(distEntry)) {
  console.error("Missing dist build. Run `npm run build` first.");
  process.exit(1);
}

const mod = await import(pathToFileURL(distEntry).href);
const ok = typeof mod.createWalletServiceFromConfig === "function" && typeof mod.resolveWalletChains === "function";

if (!ok) {
  console.error("Smoke test failed: expected exports are missing.");
  process.exit(1);
}

console.log("Smoke test passed.");

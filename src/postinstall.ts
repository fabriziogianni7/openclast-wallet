import { copyFile, mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

async function fileExists(targetPath: string): Promise<boolean> {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

function resolvePackageDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

function resolveSkillSourceDir(): string {
  return path.resolve(resolvePackageDir(), "../skills/openclast-wallet");
}

async function copyDir(sourceDir: string, targetDir: string): Promise<void> {
  await mkdir(targetDir, { recursive: true });
  const entries = await readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const src = path.join(sourceDir, entry.name);
    const dest = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      await copyDir(src, dest);
    } else if (entry.isFile()) {
      await copyFile(src, dest);
    }
  }
}

async function installSkill(): Promise<void> {
  const targetRoot = process.env.INIT_CWD;
  if (!targetRoot) return;
  const targetDir = path.join(targetRoot, "skills", "openclast-wallet");
  if (await fileExists(targetDir)) return;
  await copyDir(resolveSkillSourceDir(), targetDir);
  console.log(`openclast-wallet: installed skill to ${targetDir}`);
}

try {
  await installSkill();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`openclast-wallet: skill install skipped (${message})`);
}

import { execFileSync } from "node:child_process"
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"

import { join, resolve } from "pathe"

type PackageManifest = Record<string, unknown> & {
  devDependencies?: Record<string, string>
}

const repositoryRoot = resolve(import.meta.dirname, "../../..")
const serverRoot = resolve(repositoryRoot, "apps/server")
const temporaryRoot = await mkdtemp(join(tmpdir(), "folo-server-production-lock-"))
const checkOnly = process.argv.includes("--check")

const copyRuntimeManifest = async (source: string, destination: string) => {
  const manifest = JSON.parse(await readFile(source, "utf8")) as PackageManifest
  delete manifest.devDependencies
  await writeFile(destination, `${JSON.stringify(manifest, null, 2)}\n`)
}

try {
  await Promise.all([
    mkdir(resolve(temporaryRoot, "apps/server"), { recursive: true }),
    mkdir(resolve(temporaryRoot, "packages/compat-contracts"), { recursive: true }),
    mkdir(resolve(temporaryRoot, "packages/readability"), { recursive: true }),
    mkdir(resolve(temporaryRoot, "patches"), { recursive: true }),
  ])

  const copyTasks = [
    copyFile(
      resolve(serverRoot, "package.production.json"),
      resolve(temporaryRoot, "package.json"),
    ),
    copyFile(resolve(serverRoot, ".npmrc.production"), resolve(temporaryRoot, ".npmrc")),
    copyFile(
      resolve(serverRoot, "pnpm-workspace.production.yaml"),
      resolve(temporaryRoot, "pnpm-workspace.yaml"),
    ),
    copyFile(
      resolve(repositoryRoot, "patches/@mozilla__readability@0.6.0.patch"),
      resolve(temporaryRoot, "patches/@mozilla__readability@0.6.0.patch"),
    ),
    copyRuntimeManifest(
      resolve(serverRoot, "package.json"),
      resolve(temporaryRoot, "apps/server/package.json"),
    ),
    copyRuntimeManifest(
      resolve(repositoryRoot, "packages/compat-contracts/package.json"),
      resolve(temporaryRoot, "packages/compat-contracts/package.json"),
    ),
    copyRuntimeManifest(
      resolve(repositoryRoot, "packages/readability/package.json"),
      resolve(temporaryRoot, "packages/readability/package.json"),
    ),
  ]
  if (checkOnly) {
    copyTasks.push(
      copyFile(
        resolve(serverRoot, "pnpm-lock.production.yaml"),
        resolve(temporaryRoot, "pnpm-lock.yaml"),
      ),
    )
  }
  await Promise.all(copyTasks)

  execFileSync(
    "pnpm",
    [
      "--dir",
      temporaryRoot,
      "--filter-prod",
      "@follow/server...",
      "install",
      "--prod",
      "--lockfile-only",
      "--ignore-scripts",
      ...(checkOnly ? ["--frozen-lockfile"] : []),
    ],
    { stdio: "inherit" },
  )

  if (checkOnly) {
    console.info("apps/server/pnpm-lock.production.yaml is up to date")
  } else {
    await copyFile(
      resolve(temporaryRoot, "pnpm-lock.yaml"),
      resolve(serverRoot, "pnpm-lock.production.yaml"),
    )
    execFileSync(
      "pnpm",
      ["exec", "prettier", "--write", resolve(serverRoot, "pnpm-lock.production.yaml")],
      { cwd: repositoryRoot, stdio: "inherit" },
    )
    console.info("Updated apps/server/pnpm-lock.production.yaml")
  }
} finally {
  await rm(temporaryRoot, { force: true, recursive: true })
}

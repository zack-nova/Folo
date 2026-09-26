import { execFileSync } from "node:child_process"
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"

import { join, resolve } from "pathe"

type PackageManifest = Record<string, unknown> & {
  devDependencies?: Record<string, string>
}

const repositoryRoot = resolve(import.meta.dirname, "..")
const appName = process.argv.includes("--app")
  ? process.argv[process.argv.indexOf("--app") + 1]
  : undefined
if (appName !== "server" && appName !== "feed-supplier") {
  throw new Error("Expected --app server or --app feed-supplier")
}

const workspacePackages =
  appName === "server"
    ? ["compat-contracts", "feed-source-contracts", "readability"]
    : ["feed-source-contracts"]
const patchName = appName === "server" ? "@mozilla__readability@0.6.0.patch" : undefined
const appRoot = resolve(repositoryRoot, "apps", appName)
const temporaryRoot = await mkdtemp(join(tmpdir(), `folo-${appName}-production-lock-`))
const checkOnly = process.argv.includes("--check")

const copyRuntimeManifest = async (source: string, destination: string) => {
  const manifest = JSON.parse(await readFile(source, "utf8")) as PackageManifest
  delete manifest.devDependencies
  await writeFile(destination, `${JSON.stringify(manifest, null, 2)}\n`)
}

try {
  await Promise.all(
    [
      resolve(temporaryRoot, "apps", appName),
      ...workspacePackages.map((packageName) => resolve(temporaryRoot, "packages", packageName)),
      ...(patchName ? [resolve(temporaryRoot, "patches")] : []),
    ].map((directory) => mkdir(directory, { recursive: true })),
  )

  const copyTasks = [
    copyFile(resolve(appRoot, "package.production.json"), resolve(temporaryRoot, "package.json")),
    copyFile(
      resolve(appRoot, "pnpm-workspace.production.yaml"),
      resolve(temporaryRoot, "pnpm-workspace.yaml"),
    ),
    copyRuntimeManifest(
      resolve(appRoot, "package.json"),
      resolve(temporaryRoot, "apps", appName, "package.json"),
    ),
    ...workspacePackages.map((packageName) =>
      copyRuntimeManifest(
        resolve(repositoryRoot, "packages", packageName, "package.json"),
        resolve(temporaryRoot, "packages", packageName, "package.json"),
      ),
    ),
  ]
  if (patchName) {
    copyTasks.push(
      copyFile(
        resolve(repositoryRoot, "patches", patchName),
        resolve(temporaryRoot, "patches", patchName),
      ),
    )
  }
  if (checkOnly) {
    copyTasks.push(
      copyFile(
        resolve(appRoot, "pnpm-lock.production.yaml"),
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
      `@follow/${appName}...`,
      "install",
      "--prod",
      "--lockfile-only",
      "--ignore-scripts",
      ...(checkOnly ? ["--frozen-lockfile"] : []),
    ],
    { stdio: "inherit" },
  )

  if (checkOnly) {
    console.info(`apps/${appName}/pnpm-lock.production.yaml is up to date`)
  } else {
    await copyFile(
      resolve(temporaryRoot, "pnpm-lock.yaml"),
      resolve(appRoot, "pnpm-lock.production.yaml"),
    )
    execFileSync(
      "pnpm",
      ["exec", "prettier", "--write", resolve(appRoot, "pnpm-lock.production.yaml")],
      { cwd: repositoryRoot, stdio: "inherit" },
    )
    console.info(`Updated apps/${appName}/pnpm-lock.production.yaml`)
  }
} finally {
  await rm(temporaryRoot, { force: true, recursive: true })
}

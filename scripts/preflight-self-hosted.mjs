#!/usr/bin/env node

import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { createConnection } from "node:net"
import { homedir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const rootPath = fileURLToPath(new URL("..", import.meta.url))
const includeSources = process.argv.includes("--sources")
const supplierProduction = process.argv.includes("--supplier")
const coreExternalSupplier = process.argv.includes("--core-external-supplier")
const productionMode = supplierProduction || coreExternalSupplier

if (process.argv.includes("--help")) {
  console.info(`Usage: node scripts/preflight-self-hosted.mjs [--sources | --supplier | --core-external-supplier]

  (no flag)                 Local core development stack
  --sources                Local core and sources development stack
  --supplier               Standalone production supplier and same-host overlay
  --core-external-supplier Production core and same-host supplier overlay`)
  process.exit(0)
}

if ([includeSources, supplierProduction, coreExternalSupplier].filter(Boolean).length > 1) {
  console.error("Choose only one preflight mode.")
  process.exit(2)
}

const results = []

const icons = {
  fail: "✖",
  info: "•",
  pass: "✓",
  warn: "!",
}

const labels = {
  fail: "fail",
  info: "info",
  pass: "pass",
  warn: "warn",
}

const addResult = (status, title, detail, hint) => {
  results.push({ detail, hint, status, title })
}

const clean = (value) => value.trim().replace(/\s+/g, " ")

const run = (command, args, timeoutMs = 10_000, envOverrides = {}) => {
  const result = spawnSync(command, args, {
    cwd: rootPath,
    encoding: "utf8",
    env: { ...process.env, ...envOverrides },
    timeout: timeoutMs,
  })

  return {
    error: result.error,
    status: typeof result.status === "number" ? result.status : null,
    stderr: clean(result.stderr ?? ""),
    stdout: clean(result.stdout ?? ""),
  }
}

const commandOutput = (command, args, timeoutMs, envOverrides) => {
  const result = run(command, args, timeoutMs, envOverrides)
  if (result.error) return { ok: false, result }
  return { ok: result.status === 0, result }
}

const binName = (name) => (process.platform === "win32" ? `${name}.cmd` : name)

const checkWorkspaceBin = (label, relativePath, args, hint) => {
  const executablePath = join(rootPath, relativePath)
  if (!existsSync(executablePath)) {
    addResult("fail", label, `${relativePath} does not exist.`, hint)
    return
  }

  const { ok, result } = commandOutput(executablePath, args)
  if (ok) {
    addResult("pass", label, result.stdout || `${relativePath} is executable.`)
    return
  }

  addResult(
    "fail",
    label,
    result.stderr || result.stdout || result.error?.message || `${relativePath} failed.`,
    hint,
  )
}

const checkPnpmExec = (label, packageDir, command, args, hint) => {
  const { ok, result } = commandOutput("pnpm", ["--dir", packageDir, "exec", command, ...args])
  if (ok) {
    addResult("pass", label, result.stdout || `${command} is executable in ${packageDir}.`)
    return
  }

  addResult(
    "fail",
    label,
    result.stderr ||
      result.stdout ||
      result.error?.message ||
      `${command} failed in ${packageDir}.`,
    hint,
  )
}

const packageJSONPath = join(rootPath, "package.json")
const packageJSON = JSON.parse(readFileSync(packageJSONPath, "utf8"))
const expectedPnpmVersion =
  typeof packageJSON.packageManager === "string"
    ? packageJSON.packageManager.match(/^pnpm@(.+)$/)?.[1]
    : undefined

const checkNode = () => {
  const version = process.versions.node
  const major = Number(version.split(".")[0])
  if (major < 22) {
    addResult(
      "fail",
      "Node.js",
      `Current version is ${version}; self-hosted dev expects Node.js 22.`,
      "Install or activate Node.js 22, then rerun this preflight.",
    )
  } else if (major > 22) {
    addResult(
      "warn",
      "Node.js",
      `Current version is ${version}; documented local development uses Node.js 22.`,
    )
  } else {
    addResult("pass", "Node.js", version)
  }
}

const checkPnpm = () => {
  const { ok, result } = commandOutput("pnpm", ["--version"])
  if (!ok) {
    addResult(
      "fail",
      "pnpm",
      result.error?.message || result.stderr || "pnpm is not available.",
      expectedPnpmVersion
        ? `Run corepack prepare pnpm@${expectedPnpmVersion} --activate.`
        : "Install pnpm and rerun pnpm install.",
    )
    return
  }

  if (expectedPnpmVersion && result.stdout !== expectedPnpmVersion) {
    addResult(
      "fail",
      "pnpm",
      `Current version is ${result.stdout}; packageManager pins pnpm@${expectedPnpmVersion}.`,
      `Run corepack prepare pnpm@${expectedPnpmVersion} --activate.`,
    )
    return
  }

  addResult("pass", "pnpm", result.stdout)
}

const checkDockerConfig = () => {
  const dockerConfigDir = process.env.DOCKER_CONFIG || join(homedir(), ".docker")
  const dockerConfigPath = join(dockerConfigDir, "config.json")
  const dockerHost = process.env.DOCKER_HOST || "(default context)"
  addResult(
    "info",
    "Docker environment",
    `DOCKER_HOST=${dockerHost}; DOCKER_CONFIG=${dockerConfigDir}`,
  )

  if (!existsSync(dockerConfigPath)) {
    addResult("pass", "Docker credential helpers", `No config.json found at ${dockerConfigPath}.`)
    return
  }

  let dockerConfig
  try {
    dockerConfig = JSON.parse(readFileSync(dockerConfigPath, "utf8"))
  } catch (error) {
    addResult(
      "fail",
      "Docker credential helpers",
      `Could not parse ${dockerConfigPath}: ${error instanceof Error ? error.message : String(error)}`,
      "Fix the Docker config JSON or run with DOCKER_CONFIG pointing to a valid config directory.",
    )
    return
  }

  const helperNames = new Set()
  if (typeof dockerConfig.credsStore === "string" && dockerConfig.credsStore.length > 0) {
    helperNames.add(dockerConfig.credsStore)
  }
  if (dockerConfig.credHelpers && typeof dockerConfig.credHelpers === "object") {
    for (const helperName of Object.values(dockerConfig.credHelpers)) {
      if (typeof helperName === "string" && helperName.length > 0) helperNames.add(helperName)
    }
  }

  if (helperNames.size === 0) {
    addResult(
      "pass",
      "Docker credential helpers",
      `No credential helper configured in ${dockerConfigPath}.`,
    )
    return
  }

  const missingHelpers = []
  for (const helperName of helperNames) {
    const helperBinary = helperName.startsWith("docker-credential-")
      ? helperName
      : `docker-credential-${helperName}`
    const helperResult = run(helperBinary, ["version"], 3_000)
    if (
      helperResult.error &&
      "code" in helperResult.error &&
      helperResult.error.code === "ENOENT"
    ) {
      missingHelpers.push(helperBinary)
    }
  }

  if (missingHelpers.length > 0) {
    addResult(
      "fail",
      "Docker credential helpers",
      `Configured helper(s) are missing: ${missingHelpers.join(", ")}. Docker pulls can fail before containers start.`,
      "Install the missing helper, remove the stale credsStore/credHelpers entry, or run with DOCKER_CONFIG pointing to a config without that helper.",
    )
    return
  }

  addResult(
    "pass",
    "Docker credential helpers",
    `Configured helper(s) found: ${[...helperNames].join(", ")}.`,
  )
}

const checkDocker = () => {
  const docker = commandOutput("docker", ["--version"])
  if (!docker.ok) {
    addResult(
      "fail",
      "Docker CLI",
      docker.result.error?.message || docker.result.stderr || "docker is not available.",
      "Install Docker CLI and make sure it is on PATH.",
    )
    return
  }
  addResult("pass", "Docker CLI", docker.result.stdout)

  const compose = commandOutput("docker", ["compose", "version"])
  if (!compose.ok) {
    addResult(
      "fail",
      "Docker Compose",
      compose.result.stderr || compose.result.error?.message || "docker compose is not available.",
      "Install the Docker Compose CLI plugin.",
    )
  } else {
    addResult("pass", "Docker Compose", compose.result.stdout)
  }

  const daemon = commandOutput("docker", ["info", "--format", "{{.ServerVersion}}"])
  if (!daemon.ok) {
    addResult(
      "fail",
      "Docker daemon",
      daemon.result.stderr || daemon.result.error?.message || "Docker daemon is not reachable.",
      "Start Docker Desktop or Colima. If using Colima, export DOCKER_HOST=unix://$HOME/.colima/default/docker.sock.",
    )
  } else {
    addResult("pass", "Docker daemon", `Server ${daemon.result.stdout}`)
  }

  if (includeSources || supplierProduction) {
    const buildx = commandOutput("docker", ["buildx", "version"])
    if (!buildx.ok) {
      addResult(
        "fail",
        "Docker buildx",
        buildx.result.stderr || buildx.result.error?.message || "docker buildx is not available.",
        "Install docker-buildx and make Docker discover it; on Homebrew, add /opt/homebrew/lib/docker/cli-plugins to Docker cliPluginsExtraDirs.",
      )
    } else {
      addResult("pass", "Docker buildx", buildx.result.stdout)
    }
  }
}

const checkComposeFile = () => {
  if (productionMode) {
    const app = supplierProduction ? "feed-supplier" : "server"
    const base = `apps/${app}/compose.production.yaml`
    const overlay = supplierProduction
      ? "apps/feed-supplier/compose.same-host-core.yaml"
      : "apps/server/compose.same-host-supplier.yaml"
    const productionEnvFile = `apps/${app}/.env.production`
    const envFile = existsSync(join(rootPath, productionEnvFile))
      ? productionEnvFile
      : `apps/${app}/.env.production.example`
    const envOverrides = coreExternalSupplier
      ? {
          FOLO_ENV_FILE:
            envFile === productionEnvFile ? ".env.production" : ".env.production.example",
        }
      : {}
    const expectedServices = supplierProduction
      ? ["feed-supplier", "feed-supplier-postgres", "redis", "rsshub"]
      : ["api", "postgres"]

    for (const [label, files] of [
      ["Production Compose", [base]],
      ["Same-host Compose overlay", [base, overlay]],
    ]) {
      const args = [
        "compose",
        ...files.flatMap((file) => ["-f", file]),
        "--env-file",
        envFile,
        "config",
        "--format",
        "json",
      ]
      const config = commandOutput("docker", args, 10_000, envOverrides)
      if (!config.ok) {
        addResult(
          "fail",
          label,
          config.result.stderr || config.result.error?.message || "docker compose config failed.",
          `Check ${files.join(" and ")} and ${envFile}.`,
        )
        continue
      }

      let parsed
      try {
        parsed = JSON.parse(config.result.stdout)
      } catch {
        addResult("fail", label, "Docker Compose did not return valid JSON.")
        continue
      }
      const actualServices = Object.keys(parsed.services ?? {})
      if (coreExternalSupplier && files.length === 1) {
        const apiEnvironment = parsed.services?.api?.environment ?? {}
        if (!apiEnvironment.FEED_SUPPLIER_URL || !apiEnvironment.FEED_SUPPLIER_TOKEN) {
          addResult(
            "fail",
            "External supplier configuration",
            `FEED_SUPPLIER_URL and FEED_SUPPLIER_TOKEN must both be set in ${envFile}.`,
          )
        } else {
          addResult("pass", "External supplier configuration", "URL and internal token are set.")
        }
      }
      const missing = expectedServices.filter((service) => !actualServices.includes(service))
      const unexpected = actualServices.filter((service) => !expectedServices.includes(service))
      const sharedNetwork = parsed.networks?.["sources-link"]
      const linkedServices = actualServices.filter((service) =>
        Object.hasOwn(parsed.services[service].networks ?? {}, "sources-link"),
      )
      const expectedLinked = supplierProduction ? "feed-supplier" : "api"
      const invalidLink =
        files.length === 2
          ? sharedNetwork?.external !== true ||
            sharedNetwork?.name !== "folo-sources-internal" ||
            linkedServices.length !== 1 ||
            linkedServices[0] !== expectedLinked
          : linkedServices.length > 0

      if (missing.length || unexpected.length || invalidLink) {
        addResult(
          "fail",
          label,
          `Services: ${actualServices.join(", ")}; shared-network members: ${linkedServices.join(", ") || "none"}.`,
          "Only the API and supplier may join the optional external network; database, Redis and RSSHub must stay isolated.",
        )
      } else {
        addResult(
          "pass",
          label,
          `Services: ${actualServices.join(", ")}; shared-network members: ${linkedServices.join(", ") || "none"}.`,
        )
      }
    }
    return
  }

  const args = ["compose", "-f", "apps/server/compose.yaml"]
  if (includeSources) args.push("--profile", "sources")
  args.push("config", "--services")

  const services = commandOutput("docker", args)
  if (!services.ok) {
    addResult(
      "fail",
      "Compose file",
      services.result.stderr || services.result.error?.message || "docker compose config failed.",
      "Check apps/server/compose.yaml and Docker Compose installation.",
    )
    return
  }

  const expectedServices = includeSources
    ? ["postgres", "redis", "rsshub", "feed-supplier-postgres", "feed-supplier"]
    : ["postgres"]
  const actualServices = new Set(services.result.stdout.split(/\s+/).filter(Boolean))
  const missingServices = expectedServices.filter((service) => !actualServices.has(service))
  if (missingServices.length > 0) {
    addResult(
      "fail",
      "Compose file",
      `Missing expected service(s): ${missingServices.join(", ")}.`,
      "Check apps/server/compose.yaml profiles.",
    )
    return
  }

  addResult("pass", "Compose file", `Services: ${[...actualServices].join(", ")}`)
}

const canConnect = (port) =>
  new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port })
    const done = (open) => {
      socket.destroy()
      resolve(open)
    }
    socket.setTimeout(500)
    socket.once("connect", () => done(true))
    socket.once("timeout", () => done(false))
    socket.once("error", () => done(false))
  })

const checkPorts = async () => {
  const ports = productionMode
    ? []
    : [
        { name: "Desktop Web", port: 2233 },
        { name: "API", port: 3000 },
        { name: "Postgres", port: 54329 },
      ]
  if (supplierProduction) ports.push({ name: "Feed Supplier", port: 3001 })
  if (coreExternalSupplier) ports.push({ name: "API", port: 3000 })
  if (includeSources) {
    ports.push(
      { name: "Feed Supplier", port: 3001 },
      { name: "Feed Supplier Postgres", port: 54330 },
    )
  }

  const occupied = []
  for (const item of ports) {
    if (await canConnect(item.port)) occupied.push(`${item.name} :${item.port}`)
  }

  if (occupied.length === 0) {
    addResult(
      "pass",
      "Local ports",
      `No listeners detected on ${ports.map((item) => item.port).join(", ")}.`,
    )
    return
  }

  addResult(
    "warn",
    "Local ports",
    `Already listening: ${occupied.join(", ")}.`,
    "This is fine if the self-hosted stack is already running. Stop the existing process/container before starting a fresh copy.",
  )
}

const checkWorkspace = () => {
  checkWorkspaceBin(
    "Root tsx",
    join("node_modules", ".bin", binName("tsx")),
    ["--version"],
    "Run pnpm install. If the package store is corrupted, run pnpm reinstall.",
  )
  checkWorkspaceBin(
    "Server tsx",
    join("apps", "server", "node_modules", ".bin", binName("tsx")),
    ["--version"],
    "Run pnpm install. If the generated node_modules links remain broken, run pnpm reinstall.",
  )
  checkPnpmExec(
    "Desktop Vite",
    "apps/desktop",
    "vite",
    ["--version"],
    "Run pnpm install. If the generated node_modules links remain broken, run pnpm reinstall.",
  )
}

checkNode()
checkPnpm()
if (!productionMode) checkWorkspace()
checkDockerConfig()
checkDocker()
checkComposeFile()
await checkPorts()

console.info(
  `\nFolo self-hosted preflight${supplierProduction ? " for standalone supplier" : coreExternalSupplier ? " for external-supplier core" : includeSources ? " with sources" : ""}\n`,
)
for (const result of results) {
  console.info(`${icons[result.status]} [${labels[result.status]}] ${result.title}`)
  if (result.detail) console.info(`  ${result.detail}`)
  if (result.hint) console.info(`  Hint: ${result.hint}`)
}

const failures = results.filter((result) => result.status === "fail")
const warnings = results.filter((result) => result.status === "warn")

console.info("")
if (failures.length > 0) {
  console.error(
    `Preflight failed with ${failures.length} failure(s) and ${warnings.length} warning(s).`,
  )
  process.exitCode = 1
} else {
  console.info(`Preflight passed with ${warnings.length} warning(s).`)
  console.info(
    supplierProduction
      ? "Next: follow the standalone production command in apps/feed-supplier/README.md."
      : coreExternalSupplier
        ? "Next: follow the matching production topology in apps/server/README.md."
        : includeSources
          ? "Next: pnpm dev:self-hosted:sources"
          : "Next: pnpm dev:self-hosted",
  )
}

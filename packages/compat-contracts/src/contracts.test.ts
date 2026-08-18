import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"

import { join, resolve } from "pathe"
import { describe, expect, it } from "vitest"

import {
  createCapabilityNotImplementedContract,
  isStructuredSuccessResponse,
  parseEntryContentNdjson,
} from "."

interface FrozenApiUsage {
  sdkVersion: string
  sdkCodeHash: string
  routes: Array<{ api: string }>
  nonSdkRequests: Array<{ method: string; path: string }>
}

interface CapabilityDefinition {
  id: string
  targetStage: number | null
  provider: "local" | "unavailable"
  clientBehavior: "enabled_when_advertised" | "hidden"
  sdkApis: string[]
  nonSdkRequests: string[]
  protocolRoutes: string[]
}

interface CapabilityManifest {
  schemaVersion: number
  compatibilityVersion: string
  extensionContractVersion: string
  manifestEndpoint: string
  capabilities: CapabilityDefinition[]
  extensionRoutes: string[]
}

interface StageZeroBaseline {
  apiUsage: {
    sdkRoutes: number
    nonSdkRequests: number
  }
  client: {
    betterAuthStripeVersion: string
    betterAuthVersion: string
    clientSdkVersion: string
    clientSdkCodeHash: string
    nodeVersion: string
    packageManager?: string
    pnpmVersion: string
    typescriptVersion: string
  }
  localProjection: {
    schemaFile: string
    sha256: string
    criticalTables: string[]
  }
  firstReleaseTargets: string[]
  nonGoals: string[]
}

const packageRoot = fileURLToPath(new URL("..", import.meta.url))
const repositoryRoot = resolve(packageRoot, "../..")
const contractsRoot = join(packageRoot, "contracts")

const readJson = async <T>(path: string): Promise<T> =>
  JSON.parse(await readFile(path, "utf8")) as T

const sortedUnique = (items: string[]): string[] => [...new Set(items)].sort()

describe("stage 0 baseline", () => {
  it("pins the verified toolchain, SDK artifact, and local projection schema", async () => {
    const baseline = await readJson<StageZeroBaseline>(join(contractsRoot, "stage-0-baseline.json"))
    const usage = await readJson<FrozenApiUsage>(join(contractsRoot, "api-usage.generated.json"))
    const rootPackage = await readJson<{ packageManager: string }>(
      join(repositoryRoot, "package.json"),
    )
    const workspace = await readFile(join(repositoryRoot, "pnpm-workspace.yaml"), "utf8")
    const schema = await readFile(join(repositoryRoot, baseline.localProjection.schemaFile))
    const sdkPackage = await readJson<{ version: string; "x-code-hash": string }>(
      join(repositoryRoot, "node_modules/@follow-app/client-sdk/package.json"),
    )
    const betterAuthPackage = await readJson<{ version: string }>(
      join(repositoryRoot, "node_modules/better-auth/package.json"),
    )
    const betterAuthStripePackage = await readJson<{ version: string }>(
      join(repositoryRoot, "node_modules/@better-auth/stripe/package.json"),
    )

    expect(rootPackage.packageManager).toBe(`pnpm@${baseline.client.pnpmVersion}`)
    expect(workspace).toContain(`"@follow-app/client-sdk": ${baseline.client.clientSdkVersion}`)
    expect(workspace).toContain(`typescript: ${baseline.client.typescriptVersion}`)
    expect(process.versions.node.split(".")[0]).toBe(baseline.client.nodeVersion.split(".")[0])
    expect(sdkPackage.version).toBe(baseline.client.clientSdkVersion)
    expect(sdkPackage["x-code-hash"]).toBe(baseline.client.clientSdkCodeHash)
    expect(betterAuthPackage.version).toBe(baseline.client.betterAuthVersion)
    expect(betterAuthStripePackage.version).toBe(baseline.client.betterAuthStripeVersion)
    expect(usage.sdkVersion).toBe(baseline.client.clientSdkVersion)
    expect(usage.sdkCodeHash).toBe(baseline.client.clientSdkCodeHash)
    expect(usage.routes).toHaveLength(baseline.apiUsage.sdkRoutes)
    expect(
      usage.nonSdkRequests.filter((request) => !request.path.startsWith("/api/extensions/")),
    ).toHaveLength(baseline.apiUsage.nonSdkRequests)
    expect(createHash("sha256").update(schema).digest("hex")).toBe(baseline.localProjection.sha256)

    for (const table of baseline.localProjection.criticalTables) {
      expect(schema.toString()).toContain(`sqliteTable("${table}"`)
    }
    expect(baseline.firstReleaseTargets).toEqual(["web", "desktop"])
    expect(baseline.nonGoals).toContain("official_capability_adapters")
  })
})

describe("capability manifest", () => {
  it("classifies every production SDK and non-SDK request exactly once", async () => {
    const usage = await readJson<FrozenApiUsage>(join(contractsRoot, "api-usage.generated.json"))
    const manifest = await readJson<CapabilityManifest>(join(contractsRoot, "capabilities.json"))
    const usedApis = usage.routes.map((route) => route.api)
    const classifiedApis = manifest.capabilities.flatMap((capability) => capability.sdkApis)
    const usedNonSdkRequests = usage.nonSdkRequests.map((route) => `${route.method} ${route.path}`)
    const classifiedNonSdkRequests = manifest.capabilities.flatMap(
      (capability) => capability.nonSdkRequests,
    )

    expect(classifiedApis).toHaveLength(new Set(classifiedApis).size)
    expect(classifiedNonSdkRequests).toHaveLength(new Set(classifiedNonSdkRequests).size)
    expect(sortedUnique(classifiedApis)).toEqual(sortedUnique(usedApis))
    expect(sortedUnique(classifiedNonSdkRequests)).toEqual(sortedUnique(usedNonSdkRequests))
  })

  it("uses explicit client behavior and never selects an official provider before stage 5", async () => {
    const manifest = await readJson<CapabilityManifest>(join(contractsRoot, "capabilities.json"))

    expect(manifest.schemaVersion).toBe(3)
    expect(manifest.compatibilityVersion).toBe("folo-client-sdk-0.3.95")
    expect(manifest.extensionContractVersion).toBe("feeds-agent-extensions-v3")
    expect(manifest.manifestEndpoint).toBe("/api/extensions/capabilities")
    expect(manifest.capabilities).toContainEqual(
      expect.objectContaining({
        id: "entries.ai_fusion",
        targetStage: 3,
        provider: "local",
        clientBehavior: "enabled_when_advertised",
      }),
    )
    expect(manifest.capabilities.map((capability) => capability.id)).toHaveLength(
      new Set(manifest.capabilities.map((capability) => capability.id)).size,
    )

    for (const capability of manifest.capabilities) {
      if (capability.provider === "unavailable") {
        expect(capability.clientBehavior).toBe("hidden")
      } else {
        expect(capability.clientBehavior).toBe("enabled_when_advertised")
        expect(capability.targetStage).not.toBeNull()
      }

      for (const route of capability.protocolRoutes) {
        expect(route).toMatch(/^(DELETE|GET|PATCH|POST|PUT) \//)
      }
    }

    const protocolRoutes = manifest.capabilities.flatMap((capability) => capability.protocolRoutes)
    expect(protocolRoutes).toHaveLength(new Set(protocolRoutes).size)
    expect(manifest.extensionRoutes).toHaveLength(new Set(manifest.extensionRoutes).size)
    for (const route of manifest.extensionRoutes) {
      expect(route).toMatch(/^(DELETE|GET|PATCH|POST|PUT) \//)
    }
  })
})

describe("response fixtures", () => {
  it("keeps JSON success envelopes SDK-compatible", async () => {
    const fixtures = [
      "success/subscriptions-empty.json",
      "success/entries-empty.json",
      "success/status-configs-minimal.json",
    ]

    for (const fixture of fixtures) {
      expect(
        isStructuredSuccessResponse(await readJson(join(contractsRoot, "fixtures", fixture))),
      ).toBe(true)
    }
  })

  it("freezes the 501 capability error body", async () => {
    const expected = await readJson(
      join(contractsRoot, "fixtures/errors/capability-not-implemented.json"),
    )
    const actual = createCapabilityNotImplementedContract("billing_and_wallet")

    expect(actual.status).toBe(501)
    expect(actual.body).toEqual(expected)
  })

  it("freezes the entry content NDJSON stream shape", async () => {
    const fixture = await readFile(
      join(contractsRoot, "fixtures/streams/entry-content.ndjson"),
      "utf8",
    )

    expect(parseEntryContentNdjson(fixture)).toEqual([
      { id: "entry-1", content: "<p>First frozen entry content</p>" },
      { id: "entry-2", content: "<p>Second frozen entry content</p>" },
    ])
  })
})

import { mkdir, readFile, writeFile } from "node:fs/promises"
import { pathToFileURL } from "node:url"

import fg from "fast-glob"
import { dirname, join, relative, resolve } from "pathe"
import { format, resolveConfig } from "prettier"
import ts from "typescript"

interface RouteDefinition {
  method: string
  path: string
  params?: readonly string[]
  query?: readonly string[]
  body?: readonly string[]
  requestType?: string
  asRaw?: boolean
}

interface ModuleDefinition {
  prefix?: string
  routes: Record<string, RouteDefinition | Record<string, unknown>>
}

interface FrozenCallsite {
  file: string
  line: number
  target: "cli" | "desktop" | "mobile" | "shared" | "ssr"
}

interface FrozenRoute {
  api: string
  method: string
  path: string
  params: string[]
  explicitQueryFields: string[]
  explicitBodyFields: string[]
  remainingInputPlacement: "body" | "query"
  requestType: string
  responseType: "json" | "raw"
  callsites: FrozenCallsite[]
}

interface FrozenNonSdkRequest {
  method: string
  path: string
  callsites: FrozenCallsite[]
}

interface FrozenApiUsage {
  schemaVersion: 1
  sdkVersion: string
  sdkCodeHash: string
  routes: FrozenRoute[]
  nonSdkRequests: FrozenNonSdkRequest[]
}

interface KnownClientRoute {
  method: "GET" | "POST"
  path: string
  callChains: readonly (readonly string[])[]
}

const betterAuthClientRoutes: readonly KnownClientRoute[] = [
  {
    method: "POST",
    path: "/better-auth/change-email",
    callChains: [["changeEmail"]],
  },
  {
    method: "POST",
    path: "/better-auth/change-password",
    callChains: [["changePassword"]],
  },
  {
    method: "POST",
    path: "/better-auth/delete-user-custom",
    callChains: [["deleteUserCustom"]],
  },
  {
    method: "GET",
    path: "/better-auth/get-account-info",
    callChains: [["getAccountInfo"]],
  },
  {
    method: "GET",
    path: "/better-auth/get-providers",
    callChains: [["getProviders"]],
  },
  {
    method: "GET",
    path: "/better-auth/get-session",
    callChains: [["getSession"], ["useSession"]],
  },
  {
    method: "POST",
    path: "/better-auth/link-social",
    callChains: [["linkSocial"]],
  },
  {
    method: "GET",
    path: "/better-auth/list-accounts",
    callChains: [["listAccounts"]],
  },
  {
    method: "GET",
    path: "/better-auth/one-time-token/generate",
    callChains: [["oneTimeToken", "generate"]],
  },
  {
    method: "POST",
    path: "/better-auth/one-time-token/apply",
    callChains: [["oneTimeToken", "apply"]],
  },
  {
    method: "POST",
    path: "/better-auth/request-password-reset",
    callChains: [["forgetPassword"], ["requestPasswordReset"]],
  },
  {
    method: "POST",
    path: "/better-auth/reset-password",
    callChains: [["resetPassword"]],
  },
  {
    method: "POST",
    path: "/better-auth/send-verification-email",
    callChains: [["sendVerificationEmail"]],
  },
  {
    method: "POST",
    path: "/better-auth/sign-in/email",
    callChains: [["signIn", "email"]],
  },
  {
    method: "POST",
    path: "/better-auth/sign-in/magic-link",
    callChains: [["signIn", "magicLink"]],
  },
  {
    method: "POST",
    path: "/better-auth/sign-in/social",
    callChains: [["signIn", "social"]],
  },
  {
    method: "POST",
    path: "/better-auth/sign-out",
    callChains: [["signOut"]],
  },
  {
    method: "POST",
    path: "/better-auth/sign-up/email",
    callChains: [["signUp", "email"]],
  },
  {
    method: "POST",
    path: "/better-auth/subscription/upgrade",
    callChains: [["subscription", "upgrade"]],
  },
  {
    method: "POST",
    path: "/better-auth/two-factor/disable",
    callChains: [["twoFactor", "disable"]],
  },
  {
    method: "POST",
    path: "/better-auth/two-factor/enable",
    callChains: [["twoFactor", "enable"]],
  },
  {
    method: "POST",
    path: "/better-auth/two-factor/verify-totp",
    callChains: [["twoFactor", "verifyTotp"]],
  },
  {
    method: "POST",
    path: "/better-auth/unlink-account",
    callChains: [["unlinkAccount"]],
  },
  {
    method: "POST",
    path: "/better-auth/update-user",
    callChains: [["updateUser"]],
  },
]

const findRepositoryRoot = async (start: string): Promise<string> => {
  let current = resolve(start)

  while (true) {
    try {
      await readFile(join(current, "pnpm-workspace.yaml"), "utf8")
      return current
    } catch {
      const parent = dirname(current)
      if (parent === current) throw new Error("Could not find repository root")
      current = parent
    }
  }
}

const normalizeRoutePath = (prefix: string | undefined, path: string): string => {
  const combined = `${prefix ?? ""}/${path}`.replaceAll(/\/{2,}/g, "/")
  return combined.length > 1 && combined.endsWith("/") ? combined.slice(0, -1) : combined
}

const isRouteDefinition = (value: unknown): value is RouteDefinition =>
  typeof value === "object" &&
  value !== null &&
  "method" in value &&
  typeof value.method === "string" &&
  "path" in value &&
  typeof value.path === "string"

const flattenModuleRoutes = (
  moduleName: string,
  moduleDefinition: ModuleDefinition,
): Omit<FrozenRoute, "callsites">[] => {
  const flattened: Omit<FrozenRoute, "callsites">[] = []

  const visit = (routes: Record<string, unknown>, parents: string[]) => {
    for (const [name, value] of Object.entries(routes)) {
      if (isRouteDefinition(value)) {
        flattened.push({
          api: [moduleName, ...parents, name].join("."),
          method: value.method,
          path: normalizeRoutePath(moduleDefinition.prefix, value.path),
          params: [...(value.params ?? [])],
          explicitQueryFields: [...(value.query ?? [])],
          explicitBodyFields: [...(value.body ?? [])],
          remainingInputPlacement: value.method === "GET" ? "query" : "body",
          requestType: value.requestType ?? "json",
          responseType: value.asRaw ? "raw" : "json",
        })
        continue
      }

      if (typeof value === "object" && value !== null) {
        visit(value as Record<string, unknown>, [...parents, name])
      }
    }
  }

  visit(moduleDefinition.routes, [])
  return flattened
}

const propertyChain = (expression: ts.Expression): string[] | null => {
  if (ts.isIdentifier(expression)) return [expression.text]

  if (expression.kind === ts.SyntaxKind.ThisKeyword) return ["this"]

  if (ts.isCallExpression(expression)) return propertyChain(expression.expression)

  if (ts.isPropertyAccessExpression(expression)) {
    const parent = propertyChain(expression.expression)
    return parent ? [...parent, expression.name.text] : null
  }

  if (
    ts.isElementAccessExpression(expression) &&
    expression.argumentExpression &&
    ts.isStringLiteral(expression.argumentExpression)
  ) {
    const parent = propertyChain(expression.expression)
    return parent ? [...parent, expression.argumentExpression.text] : null
  }

  return null
}

const chainEndsWith = (chain: readonly string[], suffix: readonly string[]): boolean =>
  chain.length >= suffix.length &&
  suffix.every((segment, index) => chain[chain.length - suffix.length + index] === segment)

const getLiteralPath = (expression: ts.Expression | undefined): string | null => {
  if (!expression) return null
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return expression.text.startsWith("/") ? expression.text : null
  }

  if (ts.isTemplateExpression(expression)) {
    const template = [
      expression.head.text,
      ...expression.templateSpans.flatMap((span) => ["{expression}", span.literal.text]),
    ].join("")
    const pathStart = template.indexOf("/")
    return pathStart >= 0 ? template.slice(pathStart) : null
  }

  return null
}

const getRequestMethod = (expression: ts.Expression | undefined): string => {
  if (!expression || !ts.isObjectLiteralExpression(expression)) return "GET"

  for (const property of expression.properties) {
    if (
      ts.isPropertyAssignment(property) &&
      property.name.getText().replaceAll(/["']/g, "") === "method" &&
      ts.isStringLiteral(property.initializer)
    ) {
      return property.initializer.text.toUpperCase()
    }
  }

  return "GET"
}

const targetForFile = (file: string): FrozenCallsite["target"] => {
  if (file.startsWith("apps/desktop/")) return "desktop"
  if (file.startsWith("apps/mobile/")) return "mobile"
  if (file.startsWith("apps/ssr/")) return "ssr"
  if (file.startsWith("apps/cli/")) return "cli"
  return "shared"
}

const sourceFiles = async (repositoryRoot: string): Promise<string[]> =>
  fg(["apps/**/*.{ts,tsx}", "packages/**/*.{ts,tsx}"], {
    cwd: repositoryRoot,
    absolute: true,
    onlyFiles: true,
    ignore: [
      "**/node_modules/**",
      "**/out/**",
      "**/dist/**",
      "**/.next/**",
      "**/.open-next/**",
      "**/__tests__/**",
      "**/e2e/**",
      "**/*.test.ts",
      "**/*.test.tsx",
      "**/*.spec.ts",
      "**/*.spec.tsx",
      "packages/compat-contracts/**",
    ],
  })

const collectUsage = async (
  repositoryRoot: string,
  allRoutes: Omit<FrozenRoute, "callsites">[],
): Promise<Pick<FrozenApiUsage, "routes" | "nonSdkRequests">> => {
  const routeCallsites = new Map<string, FrozenCallsite[]>()
  const nonSdkCallsites = new Map<string, FrozenCallsite[]>()
  const routeSegments = allRoutes
    .map((route) => ({ route, segments: route.api.split(".") }))
    .sort((left, right) => right.segments.length - left.segments.length)

  for (const absoluteFile of await sourceFiles(repositoryRoot)) {
    const file = relative(repositoryRoot, absoluteFile)
    const source = await readFile(absoluteFile, "utf8")
    const sourceFile = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    )

    const addCallsite = (collection: Map<string, FrozenCallsite[]>, key: string, node: ts.Node) => {
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
      const callsite = { file, line, target: targetForFile(file) }
      const current = collection.get(key) ?? []
      if (!current.some((item) => item.file === file && item.line === line)) {
        current.push(callsite)
        collection.set(key, current)
      }
    }

    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const chain = propertyChain(node.expression)
        if (chain) {
          const matchedRoute = routeSegments.find(({ segments }) => chainEndsWith(chain, segments))
          const matchedBetterAuthRoute = betterAuthClientRoutes.find((route) =>
            route.callChains.some((callChain) => chainEndsWith(chain, callChain)),
          )

          if (matchedRoute) {
            addCallsite(routeCallsites, matchedRoute.route.api, node)
          } else if (matchedBetterAuthRoute) {
            addCallsite(
              nonSdkCallsites,
              `${matchedBetterAuthRoute.method} ${matchedBetterAuthRoute.path}`,
              node,
            )
          } else if (chain.at(-1) === "request") {
            const path = getLiteralPath(node.arguments[0])
            if (path) {
              const method = getRequestMethod(node.arguments[1])
              addCallsite(nonSdkCallsites, `${method} ${path}`, node)
            }
          } else if (chain.at(-1) === "fetch" || (chain.length === 1 && chain[0] === "fetch")) {
            const path = getLiteralPath(node.arguments[0])
            if (path?.startsWith("/better-auth")) {
              const method = getRequestMethod(node.arguments[1])
              addCallsite(nonSdkCallsites, `${method} ${path}`, node)
            }
          }
        }
      }

      ts.forEachChild(node, visit)
    }

    visit(sourceFile)
  }

  const routes = allRoutes
    .filter((route) => routeCallsites.has(route.api))
    .map((route) => ({
      ...route,
      callsites: (routeCallsites.get(route.api) ?? []).sort((left, right) =>
        `${left.file}:${left.line}`.localeCompare(`${right.file}:${right.line}`),
      ),
    }))
    .sort((left, right) => left.api.localeCompare(right.api))

  const nonSdkRequests = [...nonSdkCallsites.entries()]
    .map(([key, callsites]) => {
      const separator = key.indexOf(" ")
      return {
        method: key.slice(0, separator),
        path: key.slice(separator + 1),
        callsites: callsites.sort((left, right) =>
          `${left.file}:${left.line}`.localeCompare(`${right.file}:${right.line}`),
        ),
      }
    })
    .sort((left, right) =>
      `${left.method} ${left.path}`.localeCompare(`${right.method} ${right.path}`),
    )

  return { routes, nonSdkRequests }
}

const createFrozenUsage = async (repositoryRoot: string): Promise<FrozenApiUsage> => {
  const sdkRoot = join(repositoryRoot, "node_modules/@follow-app/client-sdk")
  const sdkPackage = JSON.parse(await readFile(join(sdkRoot, "package.json"), "utf8")) as {
    version: string
    "x-code-hash": string
  }
  const registryModule = (await import(
    pathToFileURL(join(sdkRoot, "src/modules/registry.ts")).href
  )) as { moduleRegistry: Record<string, ModuleDefinition> }
  const allRoutes = Object.entries(registryModule.moduleRegistry).flatMap(([name, definition]) =>
    flattenModuleRoutes(name, definition),
  )
  const usage = await collectUsage(repositoryRoot, allRoutes)

  return {
    schemaVersion: 1,
    sdkVersion: sdkPackage.version,
    sdkCodeHash: sdkPackage["x-code-hash"],
    ...usage,
  }
}

const main = async () => {
  const repositoryRoot = await findRepositoryRoot(process.cwd())
  const outputPath = join(
    repositoryRoot,
    "packages/compat-contracts/contracts/api-usage.generated.json",
  )
  const prettierConfig = await resolveConfig(outputPath)
  const actual = await format(JSON.stringify(await createFrozenUsage(repositoryRoot)), {
    ...prettierConfig,
    filepath: outputPath,
  })
  const mode = process.argv[2]

  if (mode === "--write") {
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, actual)
    console.log(`Updated ${relative(repositoryRoot, outputPath)}`)
    return
  }

  if (mode !== "--check") {
    throw new Error("Expected --check or --write")
  }

  const expected = await readFile(outputPath, "utf8")
  if (actual !== expected) {
    console.error(
      "FOLO API usage changed. Review the diff and run pnpm contracts:update explicitly.",
    )
    process.exitCode = 1
    return
  }

  console.log("FOLO API usage matches the frozen contract.")
}

await main()

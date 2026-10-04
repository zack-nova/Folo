import type { SourceCredentialDependency } from "@follow/feed-source-contracts"
import { parseRssHubSource } from "@follow/feed-source-contracts"

import type { SupplierRepository } from "./repository"
import type { SourceCatalogService } from "./source-catalog"

const noCredentials: SourceCredentialDependency = {
  status: "none",
  boundCredentials: [],
  rssHubCredentials: [],
  catalogRouteKey: null,
}

const unknownCredentials: SourceCredentialDependency = { ...noCredentials, status: "unknown" }

/**
 * Which personal credentials a logical source depends on (ADR-0033). Web list and page change
 * sources cannot carry credentials yet. RSSHub sources combine the supplier credentials bound to
 * the route or its catalog template with the RSSHub deployment credentials the template declares;
 * an address no template describes is unknown rather than credential-free.
 */
export const resolveCredentialDependency = async (
  sourceURL: string,
  repository: Pick<SupplierRepository, "findCredential" | "findRouteBySourceURL">,
  catalog: Pick<SourceCatalogService, "matchTemplate">,
): Promise<SourceCredentialDependency> => {
  let protocol: string
  try {
    protocol = new URL(sourceURL).protocol
  } catch {
    return unknownCredentials
  }
  if (protocol === "weblist:" || protocol === "pagechange:") return noCredentials
  if (protocol !== "rsshub:") return unknownCredentials

  let source: ReturnType<typeof parseRssHubSource>
  try {
    source = parseRssHubSource(sourceURL)
  } catch {
    return unknownCredentials
  }
  const [route, template] = await Promise.all([
    repository.findRouteBySourceURL(source.logicalURL),
    catalog.matchTemplate(source, { includeDisabled: true }),
  ])
  const credentialIds = new Set([
    ...Object.values(route?.secretQueryBindings ?? {}),
    ...Object.values(template?.secretQueryBindings ?? {}),
  ])
  const boundCredentials = (
    await Promise.all(
      [...credentialIds].map(
        async (id) => (await repository.findCredential(id))?.name ?? `missing credential ${id}`,
      ),
    )
  ).sort()
  const rssHubCredentials = template?.rssHubCredentials ?? []
  const declared = template !== null && template.rssHubCredentials !== null
  return {
    status:
      boundCredentials.length > 0 || rssHubCredentials.length > 0
        ? "uses"
        : declared
          ? "none"
          : "unknown",
    boundCredentials,
    rssHubCredentials,
    catalogRouteKey: template?.key ?? null,
  }
}

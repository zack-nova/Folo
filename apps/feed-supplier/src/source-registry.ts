import { randomUUID } from "node:crypto"

import type {
  RssHubSource,
  SourceAuditEvent,
  SourceAuditVerification,
  SourceCredentialSummary,
  SourceRegistryMode,
  SourceRouteInstance,
} from "@follow/feed-source-contracts"
import { parseRssHubSource } from "@follow/feed-source-contracts"

import { createAuditDraft } from "./audit"
import { CredentialCipher } from "./credential-cipher"
import type { StoredCredential, SupplierRepository } from "./repository"
import type { SourceCatalogService } from "./source-catalog"

export class SourceRegistryError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode: number,
  ) {
    super(message)
  }
}

export interface ResolvedRssHubSource {
  policyKey: string
  route: SourceRouteInstance | null
  secretQuery: Record<string, string>
  source: RssHubSource
}

export interface CreateCredentialInput {
  description?: string | null
  name: string
  value: string
}

export interface UpdateCredentialInput {
  description?: string | null
  name?: string
  value?: string
}

export interface CreateRouteInput {
  enabled?: boolean
  name: string
  secretQueryBindings?: Record<string, string>
  sourceURL: string
}

export interface UpdateRouteInput {
  enabled?: boolean
  name?: string
  secretQueryBindings?: Record<string, string>
}

const credentialSummary = (record: StoredCredential): SourceCredentialSummary => ({
  createdAt: record.createdAt,
  description: record.description,
  disabledAt: record.disabledAt,
  id: record.id,
  keyId: record.keyId,
  name: record.name,
  updatedAt: record.updatedAt,
})

export class SourceRegistry {
  private readonly cipher: CredentialCipher

  constructor(
    private readonly repository: SupplierRepository,
    activeKeyId: string,
    keys: ReadonlyMap<string, Buffer>,
    readonly mode: SourceRegistryMode,
    private readonly catalog?: SourceCatalogService,
  ) {
    this.cipher = new CredentialCipher(activeKeyId, keys)
  }

  async listCredentials(): Promise<SourceCredentialSummary[]> {
    return (await this.repository.listCredentials()).map(credentialSummary)
  }

  async createCredential(
    input: CreateCredentialInput,
    actor: string,
  ): Promise<SourceCredentialSummary> {
    const now = new Date().toISOString()
    const id = randomUUID()
    const encrypted = this.cipher.encrypt(id, input.value)
    const record: StoredCredential = {
      ...encrypted,
      createdAt: now,
      description: input.description ?? null,
      disabledAt: null,
      id,
      name: input.name,
      updatedAt: now,
    }
    return credentialSummary(
      await this.repository.createCredential(
        record,
        createAuditDraft(actor, "credential.created", "credential", id, {
          keyId: encrypted.keyId,
          name: input.name,
        }),
      ),
    )
  }

  async updateCredential(
    id: string,
    input: UpdateCredentialInput,
    actor: string,
  ): Promise<SourceCredentialSummary | null> {
    const current = await this.repository.findCredential(id)
    if (!current || current.disabledAt) return null
    const encrypted = input.value === undefined ? current : this.cipher.encrypt(id, input.value)
    const record: StoredCredential = {
      ...current,
      authenticationTag: encrypted.authenticationTag,
      ciphertext: encrypted.ciphertext,
      description: input.description === undefined ? current.description : input.description,
      initializationVector: encrypted.initializationVector,
      keyId: encrypted.keyId,
      name: input.name ?? current.name,
      updatedAt: new Date().toISOString(),
    }
    const updated = await this.repository.updateCredential(
      record,
      createAuditDraft(actor, "credential.updated", "credential", id, {
        keyId: record.keyId,
        name: record.name,
        secretReplaced: input.value !== undefined,
      }),
    )
    return updated ? credentialSummary(updated) : null
  }

  async disableCredential(id: string, actor: string): Promise<SourceCredentialSummary | null> {
    const disabledAt = new Date().toISOString()
    const disabled = await this.repository.disableCredential(
      id,
      disabledAt,
      createAuditDraft(actor, "credential.disabled", "credential", id, {}),
    )
    return disabled ? credentialSummary(disabled) : null
  }

  async rotateCredentials(actor: string): Promise<number> {
    const now = new Date().toISOString()
    const active = (await this.repository.listCredentials()).filter(
      (record) => !record.disabledAt && record.keyId !== this.cipher.activeId,
    )
    const rotated = active.map((record): StoredCredential => {
      const value = this.cipher.decrypt(record.id, record)
      return { ...record, ...this.cipher.encrypt(record.id, value), updatedAt: now }
    })
    return this.repository.rotateCredentials(
      rotated,
      createAuditDraft(actor, "credential.rotated", "system", null, {
        activeKeyId: this.cipher.activeId,
        rotatedCount: rotated.length,
      }),
    )
  }

  async listRoutes(): Promise<SourceRouteInstance[]> {
    return this.repository.listRoutes()
  }

  async getRoute(id: string): Promise<SourceRouteInstance | null> {
    return this.repository.findRouteById(id)
  }

  async createRoute(input: CreateRouteInput, actor: string): Promise<SourceRouteInstance> {
    const source = parseRssHubSource(input.sourceURL)
    const bindings = input.secretQueryBindings ?? {}
    this.assertSecretsAbsentFromLogicalURL(source.logicalURL, bindings)
    await this.assertBindingsAvailable(bindings)
    const now = new Date().toISOString()
    const route: SourceRouteInstance = {
      createdAt: now,
      deletedAt: null,
      enabled: input.enabled ?? true,
      id: randomUUID(),
      name: input.name,
      secretQueryBindings: bindings,
      sourceURL: source.logicalURL,
      updatedAt: now,
    }
    return this.repository.createRoute(
      route,
      createAuditDraft(actor, "route.created", "route", route.id, {
        bindingCount: Object.keys(bindings).length,
        enabled: route.enabled,
        name: route.name,
        sourceURL: route.sourceURL,
      }),
    )
  }

  async updateRoute(
    id: string,
    input: UpdateRouteInput,
    actor: string,
  ): Promise<SourceRouteInstance | null> {
    const current = await this.repository.findRouteById(id)
    if (!current) return null
    const bindings = input.secretQueryBindings ?? current.secretQueryBindings
    this.assertSecretsAbsentFromLogicalURL(current.sourceURL, bindings)
    await this.assertBindingsAvailable(bindings)
    const route: SourceRouteInstance = {
      ...current,
      enabled: input.enabled ?? current.enabled,
      name: input.name ?? current.name,
      secretQueryBindings: bindings,
      updatedAt: new Date().toISOString(),
    }
    return this.repository.updateRoute(
      route,
      createAuditDraft(actor, "route.updated", "route", id, {
        bindingCount: Object.keys(bindings).length,
        enabled: route.enabled,
        name: route.name,
      }),
    )
  }

  async deleteRoute(id: string, actor: string): Promise<SourceRouteInstance | null> {
    return this.repository.softDeleteRoute(
      id,
      new Date().toISOString(),
      createAuditDraft(actor, "route.deleted", "route", id, {}),
    )
  }

  async resolve(input: string): Promise<ResolvedRssHubSource> {
    const source = parseRssHubSource(input)
    const route = await this.repository.findRouteBySourceURL(source.logicalURL)
    const catalogMatch = route ? null : await this.catalog?.resolve(source)
    if (!route && !catalogMatch && this.mode === "managed_only") {
      throw new SourceRegistryError(
        "source_not_registered",
        "RSSHub source is not registered in the managed route registry",
        404,
      )
    }
    if (route && !route.enabled) {
      throw new SourceRegistryError("source_route_disabled", "RSSHub source route is disabled", 409)
    }
    if (catalogMatch) {
      return {
        policyKey: `catalog:${catalogMatch.route.id}`,
        route: null,
        secretQuery: catalogMatch.secretQuery,
        source,
      }
    }
    const secretQuery: Record<string, string> = {}
    for (const [parameter, credentialId] of Object.entries(route?.secretQueryBindings ?? {})) {
      const credential = await this.repository.findCredential(credentialId)
      if (!credential || credential.disabledAt) {
        throw new SourceRegistryError(
          "source_credential_unavailable",
          `Credential bound to query parameter ${parameter} is unavailable`,
          503,
        )
      }
      try {
        secretQuery[parameter] = this.cipher.decrypt(credential.id, credential)
      } catch {
        throw new SourceRegistryError(
          "source_credential_unavailable",
          `Credential bound to query parameter ${parameter} cannot be decrypted`,
          503,
        )
      }
    }
    return {
      policyKey: route ? `route:${route.id}` : `source:${source.logicalURL}`,
      route,
      secretQuery,
      source,
    }
  }

  async recordRouteTest(routeId: string, actor: string, succeeded: boolean): Promise<void> {
    await this.repository.recordAudit(
      createAuditDraft(actor, "route.tested", "route", routeId, { succeeded }),
    )
  }

  async countManagedRoutes(): Promise<number> {
    return this.repository.countManagedRoutes()
  }

  async listAuditEvents(afterSequence: number, limit: number): Promise<SourceAuditEvent[]> {
    return this.repository.listAuditEvents(afterSequence, limit)
  }

  async verifyAuditChain(): Promise<SourceAuditVerification> {
    return this.repository.verifyAuditChain()
  }

  private async assertBindingsAvailable(bindings: Record<string, string>): Promise<void> {
    for (const credentialId of new Set(Object.values(bindings))) {
      const credential = await this.repository.findCredential(credentialId)
      if (!credential || credential.disabledAt) {
        throw new SourceRegistryError(
          "source_credential_not_found",
          `Active credential ${credentialId} was not found`,
          400,
        )
      }
    }
  }

  private assertSecretsAbsentFromLogicalURL(
    sourceURL: string,
    bindings: Record<string, string>,
  ): void {
    const publicParameters = new URL(sourceURL).searchParams
    const exposedParameter = Object.keys(bindings).find((parameter) =>
      publicParameters.has(parameter),
    )
    if (exposedParameter) {
      throw new SourceRegistryError(
        "source_secret_in_logical_url",
        `Secret query parameter ${exposedParameter} must not appear in the logical source URL`,
        400,
      )
    }
  }
}

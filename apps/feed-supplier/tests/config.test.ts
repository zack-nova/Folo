import { describe, expect, it } from "vitest"

import { loadFeedSupplierConfig } from "../src/config"

describe("feed supplier configuration", () => {
  it("normalizes an internal RSSHub endpoint", () => {
    expect(
      loadFeedSupplierConfig({
        INTERNAL_TOKEN: "internal-supplier-token-0000000000000000",
        RSSHUB_BASE_URL: "http://rsshub:1200/",
      }),
    ).toMatchObject({
      port: 3001,
      rssHubBaseURL: "http://rsshub:1200",
    })
  })

  it("requires independent non-placeholder production secrets", () => {
    const environment = {
      ADMIN_TOKEN: "feed-supplier-admin-token-2222222222222222",
      AUDIT_HMAC_KEY: "CgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgo=",
      CREDENTIAL_ENCRYPTION_KEY: "CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQk=",
      CREDENTIAL_ENCRYPTION_KEY_ID: "production-primary",
      DATABASE_URL: "postgresql://feed_supplier:secret@feed-supplier-postgres/feed_supplier",
      INTERNAL_TOKEN: "internal-supplier-token-0000000000000000",
      NODE_ENV: "production",
      RSSHUB_ACCESS_KEY: "rsshub-access-key-11111111111111111111",
      RSSHUB_BASE_URL: "http://rsshub:1200",
    }
    expect(loadFeedSupplierConfig(environment)).toMatchObject({ nodeEnvironment: "production" })
    expect(() => loadFeedSupplierConfig({ ...environment, RSSHUB_ACCESS_KEY: undefined })).toThrow()
    expect(() =>
      loadFeedSupplierConfig({
        ...environment,
        RSSHUB_ACCESS_KEY: environment.INTERNAL_TOKEN,
      }),
    ).toThrow()
    expect(() =>
      loadFeedSupplierConfig({
        ...environment,
        ADMIN_TOKEN: environment.INTERNAL_TOKEN,
      }),
    ).toThrow()
  })

  it("loads historical credential keys for rotation", () => {
    const config = loadFeedSupplierConfig({
      CREDENTIAL_DECRYPTION_KEYS_JSON:
        '{"previous":"CAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg="}',
      CREDENTIAL_ENCRYPTION_KEY: "CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQk=",
      CREDENTIAL_ENCRYPTION_KEY_ID: "current",
      INTERNAL_TOKEN: "internal-supplier-token-0000000000000000",
      NODE_ENV: "test",
    })

    expect([...config.credentialKeys.keys()]).toEqual(["previous", "current"])
  })
})

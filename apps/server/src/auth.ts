import type { BetterAuthOptions } from "better-auth"
import { betterAuth } from "better-auth"

export interface CreateAuthOptions {
  baseURL: string
  database: NonNullable<BetterAuthOptions["database"]>
  secret: string
  trustedOrigins: string[]
}

export const createAuth = ({ baseURL, database, secret, trustedOrigins }: CreateAuthOptions) =>
  betterAuth({
    appName: "Folo Self-hosted",
    basePath: "/better-auth",
    baseURL,
    database,
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
    },
    secret,
    trustedOrigins,
  })

export type AppAuth = ReturnType<typeof createAuth>

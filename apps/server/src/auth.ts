import type { BetterAuthOptions } from "better-auth"
import { betterAuth } from "better-auth"
import { z } from "zod"

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
    user: {
      additionalFields: {
        handle: {
          type: "string",
          required: false,
          sortable: true,
          unique: true,
          validator: { input: z.string().max(32).regex(/^\w+$/) },
        },
        bio: {
          type: "string",
          required: false,
          validator: { input: z.string().max(256) },
        },
        website: {
          type: "string",
          required: false,
          validator: { input: z.union([z.url().max(64), z.literal("")]) },
        },
        socialLinks: {
          type: "json",
          required: false,
          validator: {
            input: z
              .object({
                discord: z.string().max(32).optional(),
                facebook: z.string().max(32).optional(),
                github: z.string().max(32).optional(),
                instagram: z.string().max(32).optional(),
                twitter: z.string().max(32).optional(),
                youtube: z.string().max(32).optional(),
              })
              .partial(),
          },
        },
      },
    },
    secret,
    trustedOrigins,
  })

export type AppAuth = ReturnType<typeof createAuth>

import { z } from "zod"

const name = z.string().trim().min(1).max(128)
const credentialId = z.uuid().nullable()
const enabled = z.boolean()
// Personal lists change slowly; checking more than hourly only adds platform load.
const intervalMinutes = z.number().int().min(60).max(525_600).nullable()

export const behaviorCreateSchema = z
  .object({
    name,
    platform: z.enum(["bilibili", "douyin", "zhihu"]),
    scope: z.enum(["favorites", "follows"]),
    accountId: z.string().trim().min(1).max(64),
    credentialId: credentialId.default(null),
    enabled: enabled.default(false),
    intervalMinutes: intervalMinutes.default(360),
  })
  .strict()
export const behaviorUpdateSchema = z
  .object({
    name: name.optional(),
    credentialId: credentialId.optional(),
    enabled: enabled.optional(),
    intervalMinutes: intervalMinutes.optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, "At least one field is required")
export const behaviorEntryQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
})

export type CreateBehaviorSourceInput = z.infer<typeof behaviorCreateSchema>
export type UpdateBehaviorSourceInput = z.infer<typeof behaviorUpdateSchema>

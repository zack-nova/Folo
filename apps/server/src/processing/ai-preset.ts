import { z } from "zod"

import type { DataStore } from "../data/types"
import { contentHash } from "./service"
import { saveProfileSnapshot, saveTaxonomySnapshot } from "./snapshots"

const condition = z
  .object({
    field: z.string().min(1),
    operator: z.enum(["contains", "eq", "gt", "lt", "not_contains", "not_eq", "regex"]),
    value: z.union([z.string(), z.number()]),
  })
  .strict()

const presetSchema = z
  .object({
    actionRules: z
      .array(
        z
          .object({
            condition: z.array(z.array(condition).min(1)),
            name: z.string().trim().min(1).max(128),
            result: z
              .object({
                evaluate: z
                  .object({
                    max_age_days: z.number().positive().max(3_650).optional(),
                    priority: z.union([z.enum(["high", "low", "normal"]), z.number()]).optional(),
                  })
                  .strict(),
              })
              .strict(),
          })
          .strict(),
      )
      .max(32),
    description: z.string(),
    profile: z.object({ name: z.string().trim().min(1).max(128) }).strict(),
    taxonomy: z
      .object({
        content: z
          .object({
            categories: z
              .array(
                z
                  .object({
                    featured_half_life_days: z.number().positive().max(365).optional(),
                    name: z.string().min(1).max(64),
                    subcategories: z.array(z.string().min(1).max(64)).max(64),
                  })
                  .strict(),
              )
              .min(1)
              .max(64),
            default_half_life_days: z.number().positive().max(365).optional(),
          })
          .strict(),
        name: z.string().trim().min(1).max(128),
      })
      .strict(),
  })
  .strict()

export type AIPreset = z.infer<typeof presetSchema>

export const parseAIPreset = (text: string): AIPreset => {
  const preset = presetSchema.parse(JSON.parse(text))
  const names = preset.actionRules.map((rule) => rule.name)
  if (new Set(names).size !== names.length) throw new Error("Action rule names must be unique")
  return preset
}

type Status = "created" | "planned" | "skipped" | "unchanged"

export interface AIPresetReport {
  actionRules: { name: string; status: "added" | "exists" | "planned" }[]
  profile: { status: Status; version: number | null }
  taxonomy: { status: Status; version: number | null }
}

/**
 * Import the processing configuration into the owner's account: a profile snapshot from a
 * local document (profiles are personal and never stored in the repository), the taxonomy
 * snapshot, and evaluate rules that do not exist yet. Existing rules are never modified, so
 * running it again only adds what is missing.
 */
export const importAIPreset = async (
  dataStore: DataStore,
  userId: string,
  preset: AIPreset,
  { apply, profileDocument }: { apply: boolean; profileDocument: string | null },
): Promise<AIPresetReport> => {
  if (profileDocument !== null && !profileDocument.trim()) {
    // An empty snapshot would become the current profile and silently degrade every evaluation.
    throw new Error("The profile document is empty")
  }
  const latest = async (kind: "profile" | "taxonomy", name: string, hash: string) => {
    const snapshots =
      kind === "profile"
        ? await dataStore.listProcessingProfileSnapshots(userId)
        : await dataStore.listProcessingTaxonomySnapshots(userId)
    const matching = snapshots.find((item) => item.name === name && item.contentHash === hash)
    return matching ? { status: "unchanged" as const, version: matching.version } : null
  }

  let profile: AIPresetReport["profile"] = { status: "skipped", version: null }
  if (profileDocument !== null) {
    const content = { document: profileDocument }
    profile =
      (await latest("profile", preset.profile.name, contentHash(content))) ??
      (apply
        ? await saveProfileSnapshot(dataStore, userId, preset.profile.name, content).then(
            ({ snapshot }) => ({ status: "created" as const, version: snapshot.version }),
          )
        : { status: "planned", version: null })
  }

  const taxonomyContent = preset.taxonomy.content as Record<string, unknown>
  const taxonomy: AIPresetReport["taxonomy"] =
    (await latest("taxonomy", preset.taxonomy.name, contentHash(taxonomyContent))) ??
    (apply
      ? await saveTaxonomySnapshot(dataStore, userId, preset.taxonomy.name, taxonomyContent).then(
          ({ snapshot }) => ({ status: "created" as const, version: snapshot.version }),
        )
      : { status: "planned", version: null })

  // Compare-and-set: rules the owner saves while this runs make the write fail and retry,
  // instead of being overwritten by a stale copy.
  let existingNames = new Set<unknown>()
  for (let attempt = 0; ; attempt += 1) {
    const record = await dataStore.getActionRules(userId)
    const current = record?.rules ?? []
    existingNames = new Set(current.map((rule) => rule.name))
    const missing = preset.actionRules.filter((rule) => !existingNames.has(rule.name))
    if (!apply || missing.length === 0) break
    if (
      await dataStore.setActionRulesIfUnchanged(
        userId,
        [...current, ...missing],
        record?.updatedAt ?? null,
      )
    ) {
      break
    }
    if (attempt >= 2) throw new Error("Action rules kept changing during the import; try again")
  }
  return {
    actionRules: preset.actionRules.map((rule) => ({
      name: rule.name,
      status: existingNames.has(rule.name) ? "exists" : apply ? "added" : "planned",
    })),
    profile,
    taxonomy,
  }
}

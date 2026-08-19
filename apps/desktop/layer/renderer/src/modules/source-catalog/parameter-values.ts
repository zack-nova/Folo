import type {
  SourceCatalogParameter,
  SourceCatalogParameterValue,
} from "@follow/feed-source-contracts"

export type SourceCatalogFormValues = Record<string, SourceCatalogParameterValue | "">

export const initialCatalogValues = (
  parameters: SourceCatalogParameter[],
): SourceCatalogFormValues =>
  Object.fromEntries(
    parameters.map((parameter) => [
      parameter.key,
      parameter.defaultValue ?? (parameter.type === "boolean" ? false : ""),
    ]),
  )

export const catalogRequestValues = (
  parameters: SourceCatalogParameter[],
  values: SourceCatalogFormValues,
): Record<string, SourceCatalogParameterValue> =>
  Object.fromEntries(
    parameters.flatMap((parameter) => {
      const value = values[parameter.key]
      if (value === "" || value === undefined) return []
      return [[parameter.key, parameter.type === "integer" ? Number(value) : value]]
    }),
  )

export const catalogValuesComplete = (
  parameters: SourceCatalogParameter[],
  values: SourceCatalogFormValues,
): boolean =>
  parameters.every(
    (parameter) =>
      !parameter.required ||
      parameter.defaultValue !== null ||
      (values[parameter.key] !== "" && values[parameter.key] !== undefined),
  )

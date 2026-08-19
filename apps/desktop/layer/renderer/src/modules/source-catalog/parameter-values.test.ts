import type { SourceCatalogParameter } from "@follow/feed-source-contracts"
import { describe, expect, it } from "vitest"

import {
  catalogRequestValues,
  catalogValuesComplete,
  initialCatalogValues,
} from "./parameter-values"

const parameters: SourceCatalogParameter[] = [
  {
    defaultValue: null,
    description: null,
    key: "project",
    label: "Project",
    location: "path",
    maximum: null,
    minimum: null,
    options: [],
    required: true,
    type: "string",
  },
  {
    defaultValue: 20,
    description: null,
    key: "limit",
    label: "Limit",
    location: "query",
    maximum: 100,
    minimum: 1,
    options: [],
    required: false,
    type: "integer",
  },
]

describe("source catalog parameter values", () => {
  it("applies defaults and sends typed values only after required fields are filled", () => {
    const values = initialCatalogValues(parameters)
    expect(values).toEqual({ limit: 20, project: "" })
    expect(catalogValuesComplete(parameters, values)).toBe(false)

    values.project = "folo"
    expect(catalogValuesComplete(parameters, values)).toBe(true)
    expect(catalogRequestValues(parameters, values)).toEqual({ limit: 20, project: "folo" })
  })
})

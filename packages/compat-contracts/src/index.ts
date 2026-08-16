export type CapabilityProvider = "local" | "unavailable"

export interface CapabilityNotImplementedBody {
  code: "capability_not_implemented"
  message: string
  data: {
    capability: string
  }
}

export interface CapabilityNotImplementedContract {
  status: 501
  body: CapabilityNotImplementedBody
}

export const createCapabilityNotImplementedContract = (
  capability: string,
): CapabilityNotImplementedContract => ({
  status: 501,
  body: {
    code: "capability_not_implemented",
    message: `Capability is not implemented: ${capability}`,
    data: { capability },
  },
})

export const isStructuredSuccessResponse = (
  value: unknown,
): value is { code: 0; data: unknown } => {
  if (typeof value !== "object" || value === null) return false

  const response = value as Record<string, unknown>
  return response.code === 0 && "data" in response
}

export const parseEntryContentNdjson = (source: string): Array<{ id: string; content: string }> =>
  source
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { id: string; content: string })

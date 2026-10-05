import { describe, expect, it } from "vitest"

import { DEFAULT_VALUES, isOfficialAPIURL } from "./env.common"

describe("isOfficialAPIURL", () => {
  it("recognizes the official servers", () => {
    expect(isOfficialAPIURL(DEFAULT_VALUES.PROD.API_URL)).toBe(true)
    expect(isOfficialAPIURL(`${DEFAULT_VALUES.PROD.API_URL}/`)).toBe(true)
    expect(isOfficialAPIURL(DEFAULT_VALUES.DEV.API_URL)).toBe(true)
  })

  it("treats every other server as self-hosted", () => {
    expect(isOfficialAPIURL("https://api.reader.example.com")).toBe(false)
    expect(isOfficialAPIURL(DEFAULT_VALUES.LOCAL.API_URL)).toBe(false)
    expect(isOfficialAPIURL("https://api.folo.is.example.com")).toBe(false)
  })
})

import { atom } from "jotai"

import { createAtomHooks } from "~/lib/jotai"

export type CapabilityManifestState = ReadonlySet<string> | null | undefined

export const checkCapability = (manifest: CapabilityManifestState, capability: string): boolean =>
  manifest === null || manifest?.has(capability) === true

export const [, , useCapabilityManifest, , , setCapabilityManifest] = createAtomHooks(
  atom<CapabilityManifestState>(undefined),
)

export const useCapability = (capability: string): boolean =>
  checkCapability(useCapabilityManifest(), capability)

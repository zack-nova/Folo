import { env } from "@follow/shared/env.desktop"
import { useQuery } from "@tanstack/react-query"
import { useEffect } from "react"

import { setCapabilityManifest } from "~/atoms/capabilities"

interface CapabilityManifestResponse {
  code: 0
  data: {
    capabilities: Array<{ id: string; provider: "local" }>
  }
}

export const CapabilitiesProvider = () => {
  const { data, isError } = useQuery({
    queryKey: ["self-hosted-capabilities", env.VITE_API_URL],
    queryFn: async () => {
      const response = await fetch(`${env.VITE_API_URL}/api/extensions/capabilities`, {
        credentials: "include",
      })
      if (!response.ok) throw new Error("Capability manifest is unavailable")
      return (await response.json()) as CapabilityManifestResponse
    },
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  })

  useEffect(() => {
    if (data) {
      setCapabilityManifest(new Set(data.data.capabilities.map((capability) => capability.id)))
    } else if (isError) {
      setCapabilityManifest(null)
    }
  }, [data, isError])

  return null
}

import type { CSSProperties } from "react"

const chipsFadeMask =
  "linear-gradient(to right, transparent, #000 12px, #000 calc(100% - 12px), transparent)"

export const categoryChipsStyles = {
  scroller: {
    maskImage: chipsFadeMask,
    WebkitMaskImage: chipsFadeMask,
  },
} satisfies Record<string, CSSProperties>

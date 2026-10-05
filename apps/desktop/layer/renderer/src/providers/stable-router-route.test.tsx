import { setRoute, useReadonlyRoute } from "@follow/components/atoms/route.js"
import { StableRouterProvider } from "@follow/components/providers/stable-router-provider.js"
import { Provider } from "jotai"
import * as React from "react"
import { act } from "react"
import type { Root } from "react-dom/client"
import { createRoot } from "react-dom/client"
import { createMemoryRouter, RouterProvider } from "react-router"
import { afterEach, beforeAll, describe, expect, test } from "vitest"

import { jotaiStore } from "~/lib/jotai"

const RouteFeedId = () => {
  const route = useReadonlyRoute()
  return <span data-testid="feed-id">{route.params.feedId ?? "none"}</span>
}

describe("StableRouterProvider", () => {
  let root: Root | null = null
  let container: HTMLElement | null = null

  beforeAll(() => {
    ;(globalThis as typeof globalThis & { React: typeof React }).React = React
    ;(
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    root = null
    container = null
    setRoute({
      params: {},
      searchParams: new URLSearchParams(),
      location: { pathname: "", search: "", hash: "", state: null, key: "" },
    })
  })

  test("route readers that mount with the provider see the initial deep link", async () => {
    // The reader renders in the same commit in which the provider publishes the route,
    // exactly like the timeline column on a fresh page load.
    const router = createMemoryRouter(
      [
        {
          path: "/timeline/:timelineId/:feedId/:entryId",
          element: (
            <>
              <StableRouterProvider />
              <RouteFeedId />
            </>
          ),
        },
      ],
      { initialEntries: ["/timeline/articles/folder-AI/pending"] },
    )

    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root!.render(
        <Provider store={jotaiStore}>
          <RouterProvider router={router} />
        </Provider>,
      )
    })

    expect(container.querySelector("[data-testid=feed-id]")?.textContent).toBe("folder-AI")
  })
})

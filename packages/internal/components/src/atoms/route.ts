import { createAtomHooks, jotaiStore } from "@follow/utils/jotai"
import { atom, useAtomValueRawSync } from "jotai"
import { selectAtom } from "jotai/utils"
import { useMemo } from "react"
import type { Location, NavigateFunction, Params } from "react-router"
import { shallow } from "zustand/shallow"

interface RouteAtom {
  params: Readonly<Params<string>>
  searchParams: URLSearchParams
  location: Location<any>
}

export const [routeAtom, , , , getReadonlyRoute, setRoute] = createAtomHooks(
  atom<RouteAtom>({
    params: {},
    searchParams: new URLSearchParams(),

    location: {
      pathname: "",
      search: "",
      hash: "",
      state: null,
      key: "",
    },
  }),
)

// StableRouterProvider writes the route in a layout effect during the first commit, after
// route readers have rendered but before jotai's effect-based subscription is attached, so
// that write would be missed and a deep link would render as the default timeline.
// useSyncExternalStore re-reads the snapshot once subscribed and never misses it.
const routeStoreOptions = { store: jotaiStore }

const noop: [] = []
export const useReadonlyRouteSelector = <T>(
  selector: (route: RouteAtom) => T,
  deps: any[] = noop,
): T =>
  useAtomValueRawSync(
    useMemo(() => selectAtom(routeAtom, (route) => selector(route), shallow), deps),
    routeStoreOptions,
  )
export const useReadonlyRoute = () => useAtomValueRawSync(routeAtom, routeStoreOptions)

// Vite HMR will create new router instance, but RouterProvider always stable

const [, , , , navigate, setNavigate] = createAtomHooks(
  atom<{ fn: NavigateFunction | null }>({ fn() {} }),
)
const getStableRouterNavigate = () => navigate().fn
export { getStableRouterNavigate, setNavigate }

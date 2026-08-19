import { Button } from "@follow/components/ui/button/index.js"
import { Input } from "@follow/components/ui/input/index.js"
import { Label } from "@follow/components/ui/label/index.jsx"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@follow/components/ui/select/index.jsx"
import { Switch } from "@follow/components/ui/switch/index.jsx"
import type {
  SourceCatalogParameter,
  SourceCatalogParameterValue,
  SourceCatalogRoute,
} from "@follow/feed-source-contracts"
import { useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"

import { useModalStack } from "~/components/ui/modal/stacked/hooks"
import { FeedForm } from "~/modules/discover/FeedForm"
import type { SourceCatalogFormValues } from "~/modules/source-catalog/parameter-values"
import {
  catalogRequestValues,
  catalogValuesComplete,
  initialCatalogValues,
} from "~/modules/source-catalog/parameter-values"
import { useSourceCatalog, useSourceCatalogActions } from "~/modules/source-catalog/queries"

const requestError = (error: unknown): string =>
  error instanceof Error ? error.message : "Source catalog request failed"

const safeDocumentationURL = (value: string | null): string | null => {
  if (!value) return null
  try {
    const url = new URL(value)
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : null
  } catch {
    return null
  }
}

const CatalogParameterField = ({
  parameter,
  value,
  onChange,
}: {
  parameter: SourceCatalogParameter
  value: SourceCatalogParameterValue | ""
  onChange: (value: SourceCatalogParameterValue | "") => void
}) => {
  const { t } = useTranslation("settings")
  const inputId = `source-catalog-parameter-${parameter.key}`
  const label = parameter.required
    ? t("source_catalog.parameter_required", { label: parameter.label })
    : parameter.label

  return (
    <div className="space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div>
          <Label htmlFor={inputId} className="text-sm text-text">
            {label}
          </Label>
          {parameter.description && (
            <p className="mt-0.5 text-xs leading-relaxed text-text-secondary">
              {parameter.description}
            </p>
          )}
        </div>
        <span className="rounded-md bg-fill-quinary px-1.5 py-0.5 font-mono text-[10px] text-text-tertiary">
          {parameter.location}
        </span>
      </div>

      {parameter.type === "boolean" ? (
        <Switch
          id={inputId}
          checked={value === true}
          onCheckedChange={onChange}
          aria-label={label}
        />
      ) : parameter.type === "enum" ? (
        <Select value={String(value)} onValueChange={onChange}>
          <SelectTrigger id={inputId}>
            <SelectValue placeholder={t("source_catalog.parameter_select")} />
          </SelectTrigger>
          <SelectContent>
            {parameter.options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <Input
          id={inputId}
          type={parameter.type === "integer" ? "number" : "text"}
          min={parameter.minimum ?? undefined}
          max={parameter.maximum ?? undefined}
          required={parameter.required}
          value={String(value)}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </div>
  )
}

const CatalogRouteCard = ({
  active,
  route,
  onSelect,
}: {
  active: boolean
  route: SourceCatalogRoute
  onSelect: () => void
}) => {
  const { t } = useTranslation("settings")
  return (
    <button
      type="button"
      className={`w-full rounded-xl border p-3 text-left transition-colors ${
        active
          ? "border-accent/40 bg-accent/10"
          : "border-fill-secondary bg-fill-quinary hover:bg-fill-quaternary"
      }`}
      data-testid={`source-catalog-route-${route.id}`}
      onClick={onSelect}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-medium text-text">{route.title}</h3>
          <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-text-secondary">
            {route.description ?? route.routePathTemplate}
          </p>
        </div>
        {route.requiresCredentials && (
          <i aria-hidden className="i-mgc-lock-cute-re mt-0.5 size-4 shrink-0 text-green" />
        )}
      </div>
      <div className="mt-3 flex items-center justify-between gap-3 text-[11px] text-text-tertiary">
        <span className="truncate">{route.category}</span>
        <span>{t("source_catalog.parameter_count", { count: route.parameters.length })}</span>
      </div>
    </button>
  )
}

const CatalogRouteForm = ({ route }: { route: SourceCatalogRoute }) => {
  const { t } = useTranslation("settings")
  const { dismissAll, present } = useModalStack()
  const actions = useSourceCatalogActions()
  const documentationURL = safeDocumentationURL(route.documentationURL)
  const [values, setValues] = useState<SourceCatalogFormValues>(() =>
    initialCatalogValues(route.parameters),
  )

  const complete = catalogValuesComplete(route.parameters, values)
  const requestValues = () => catalogRequestValues(route.parameters, values)

  const handleTest = async () => {
    try {
      await actions.test.mutateAsync({ parameters: requestValues(), routeId: route.id })
      toast.success(t("source_catalog.test_success"))
    } catch (error) {
      toast.error(requestError(error))
    }
  }

  const handleSubscribe = async () => {
    try {
      const rendered = await actions.render.mutateAsync({
        parameters: requestValues(),
        routeId: route.id,
      })
      present({
        content: () => <FeedForm url={rendered.logicalURL} onSuccess={dismissAll} />,
        title: t("source_catalog.subscribe_title"),
      })
    } catch (error) {
      toast.error(requestError(error))
    }
  }

  return (
    <section className="rounded-2xl border border-fill-secondary bg-material-ultra-thin p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-semibold text-text">{route.title}</h2>
            <span className="rounded-full bg-fill-quinary px-2 py-0.5 text-[11px] text-text-secondary">
              {route.category}
            </span>
          </div>
          {route.description && (
            <p className="mt-2 text-xs leading-relaxed text-text-secondary">{route.description}</p>
          )}
          <code className="mt-2 block break-all text-xs text-text-tertiary">
            {route.routePathTemplate}
          </code>
        </div>
        {documentationURL && (
          <a
            className="inline-flex shrink-0 items-center gap-1 text-xs text-blue hover:underline"
            href={documentationURL}
            rel="noreferrer"
            target="_blank"
          >
            {t("source_catalog.documentation")}
            <i className="i-mgc-external-link-cute-re size-3.5" aria-hidden />
          </a>
        )}
      </div>

      {route.requiresCredentials && (
        <div className="mt-4 flex items-start gap-2 rounded-lg border border-green/20 bg-green/5 p-3 text-xs text-green">
          <i className="i-mgc-safety-certificate-cute-re mt-0.5 size-4 shrink-0" aria-hidden />
          <p className="leading-relaxed">{t("source_catalog.credentials_server_side")}</p>
        </div>
      )}

      <div className="mt-5 space-y-4">
        {route.parameters.length === 0 ? (
          <p className="text-xs text-text-secondary">{t("source_catalog.no_parameters")}</p>
        ) : (
          route.parameters.map((parameter) => (
            <CatalogParameterField
              key={parameter.key}
              parameter={parameter}
              value={values[parameter.key] ?? ""}
              onChange={(value) => {
                setValues((current) => ({ ...current, [parameter.key]: value }))
                actions.render.reset()
                actions.test.reset()
              }}
            />
          ))
        )}
      </div>

      {actions.test.data && (
        <div
          className="mt-5 rounded-lg border border-green/20 bg-green/5 p-3"
          data-testid="source-catalog-test-result"
        >
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-green">
            <span className="inline-flex items-center gap-1 font-medium">
              <i className="i-mgc-check-circle-cute-re size-3.5" aria-hidden />
              HTTP {actions.test.data.upstreamStatus}
            </span>
            <span>{actions.test.data.contentType ?? t("source_catalog.content_type_unknown")}</span>
            <span>{t("source_catalog.bytes", { count: actions.test.data.contentBytes })}</span>
          </div>
          <code className="mt-2 block break-all text-[11px] text-text-secondary">
            {actions.test.data.logicalURL}
          </code>
        </div>
      )}

      <div className="mt-5 flex flex-wrap justify-end gap-2 border-t border-fill-secondary pt-4">
        <Button
          variant="outline"
          disabled={!complete}
          isLoading={actions.test.isPending}
          onClick={handleTest}
        >
          {t("source_catalog.test")}
        </Button>
        <Button disabled={!complete} isLoading={actions.render.isPending} onClick={handleSubscribe}>
          {t("source_catalog.preview_subscribe")}
        </Button>
      </div>
    </section>
  )
}

export const SettingSources = () => {
  const { t } = useTranslation("settings")
  const catalog = useSourceCatalog()
  const [search, setSearch] = useState("")
  const [category, setCategory] = useState("all")
  const [selectedRouteId, setSelectedRouteId] = useState<string | null>(null)
  const routes = useMemo(() => catalog.data?.routes ?? [], [catalog.data?.routes])
  const categories = useMemo(
    () => [...new Set(routes.map((route) => route.category))].sort((a, b) => a.localeCompare(b)),
    [routes],
  )
  const filteredRoutes = useMemo(() => {
    const query = search.trim().toLocaleLowerCase()
    return routes.filter(
      (route) =>
        (category === "all" || route.category === category) &&
        (!query ||
          [route.title, route.description, route.category, route.routePathTemplate]
            .filter(Boolean)
            .some((value) => value!.toLocaleLowerCase().includes(query))),
    )
  }, [category, routes, search])
  const selectedRoute =
    filteredRoutes.find((route) => route.id === selectedRouteId) ?? filteredRoutes[0] ?? null

  useEffect(() => {
    if (selectedRoute && selectedRoute.id !== selectedRouteId) {
      setSelectedRouteId(selectedRoute.id)
    }
  }, [selectedRoute, selectedRouteId])

  if (catalog.isLoading) {
    return (
      <div className="flex min-h-64 items-center justify-center text-text-secondary">
        <i className="i-mgc-loading-3-cute-re size-5 animate-spin f-motion-reduce:animate-none" />
      </div>
    )
  }
  if (catalog.isError) {
    return (
      <div className="mt-4 rounded-xl border border-red/20 bg-red/5 p-4" role="alert">
        <p className="text-sm font-medium text-red">{t("source_catalog.load_failed")}</p>
        <p className="mt-1 text-xs text-text-secondary">{catalog.error.message}</p>
        <Button
          buttonClassName="mt-3"
          size="sm"
          variant="outline"
          onClick={() => void catalog.refetch()}
        >
          {t("source_catalog.retry")}
        </Button>
      </div>
    )
  }

  return (
    <div className="mt-4 space-y-5">
      <div>
        <h2 className="text-sm font-semibold text-text">{t("source_catalog.title")}</h2>
        <p className="mt-1 text-xs leading-relaxed text-text-secondary">
          {t("source_catalog.description")}
        </p>
      </div>

      {routes.length === 0 ? (
        <div className="rounded-xl border border-dashed border-fill p-8 text-center">
          <i className="i-mgc-route-cute-re mx-auto size-7 text-text-tertiary" aria-hidden />
          <p className="mt-3 text-sm font-medium text-text">{t("source_catalog.empty_title")}</p>
          <p className="mt-1 text-xs text-text-secondary">
            {t("source_catalog.empty_description")}
          </p>
        </div>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_12rem]">
            <div className="relative">
              <i className="i-mgc-search-2-cute-re pointer-events-none absolute left-3 top-2.5 size-4 text-text-tertiary" />
              <Input
                className="pl-9"
                placeholder={t("source_catalog.search_placeholder")}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger aria-label={t("source_catalog.category_filter")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("source_catalog.all_categories")}</SelectItem>
                {categories.map((item) => (
                  <SelectItem key={item} value={item}>
                    {item}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {filteredRoutes.length === 0 ? (
            <p className="rounded-xl border border-dashed border-fill p-8 text-center text-sm text-text-secondary">
              {t("source_catalog.no_results")}
            </p>
          ) : (
            <div className="grid items-start gap-4 lg:grid-cols-[minmax(14rem,0.75fr)_minmax(0,1.25fr)]">
              <div className="grid gap-2">
                {filteredRoutes.map((route) => (
                  <CatalogRouteCard
                    key={route.id}
                    active={selectedRoute?.id === route.id}
                    route={route}
                    onSelect={() => setSelectedRouteId(route.id)}
                  />
                ))}
              </div>
              {selectedRoute && <CatalogRouteForm key={selectedRoute.id} route={selectedRoute} />}
            </div>
          )}
        </>
      )}
    </div>
  )
}

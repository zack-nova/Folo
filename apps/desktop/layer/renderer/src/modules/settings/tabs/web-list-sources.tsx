import { Button } from "@follow/components/ui/button/index.js"
import { Input } from "@follow/components/ui/input/index.js"
import { Switch } from "@follow/components/ui/switch/index.jsx"
import type { WebListSource, WebListTestResult } from "@follow/feed-source-contracts"
import { useId, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"

import { useModalStack } from "~/components/ui/modal/stacked/hooks"
import { FeedForm } from "~/modules/discover/FeedForm"
import type { WebListFormValues } from "~/modules/web-list-sources/form-values"
import {
  initialWebListValues,
  webListInput,
  webListPatch,
} from "~/modules/web-list-sources/form-values"
import {
  useWebListItems,
  useWebListSourceActions,
  useWebListSources,
} from "~/modules/web-list-sources/queries"

const safeURL = (url: string) => {
  try {
    return ["https:", "http:"].includes(new URL(url).protocol) ? url : undefined
  } catch {
    return undefined
  }
}
const excerpt = (html: string) =>
  new DOMParser().parseFromString(html, "text/html").body.textContent?.slice(0, 600) ?? ""
const time = (value: string | null) => (value ? new Date(value).toLocaleString() : "—")

const TestPreview = ({ result }: { result: WebListTestResult }) => {
  const { t } = useTranslation("settings")
  return (
    <div className="space-y-3 rounded-xl bg-fill-secondary p-4 text-xs text-text-secondary">
      <p className="break-all">
        {t("web_list_sources.finalURL")}: {result.finalURL}
      </p>
      <p>
        {t("web_list_sources.pagesRead")}: {result.pagesRead}
      </p>
      {result.items.slice(0, 20).map((item, index) => (
        <div key={`${item.url}-${index}`} className="space-y-1 border-t border-fill pt-2">
          <a
            className="text-blue hover:underline"
            href={safeURL(item.url)}
            target="_blank"
            rel="noreferrer"
          >
            {item.title}
          </a>
          <p className="break-all">{item.url}</p>
          <p>{time(item.publishedAt)}</p>
          {item.summary && <p className="whitespace-pre-wrap break-words">{item.summary}</p>}
          {item.metadata.map(([label, value], metadataIndex) => (
            <p key={metadataIndex} className="break-words">
              {label}: {value}
            </p>
          ))}
        </div>
      ))}
      {result.detail && (
        <div className="space-y-1 border-t border-fill pt-2">
          <h4 className="font-medium text-text">{t("web_list_sources.detail_preview")}</h4>
          <p>{result.detail.title}</p>
          <p>
            {result.detail.detailStatus} · {time(result.detail.publishedAt)}
          </p>
          <p className="whitespace-pre-wrap break-words">{excerpt(result.detail.content ?? "")}</p>
        </div>
      )}
    </div>
  )
}

const SourceEditor = ({ source, onClose }: { source?: WebListSource; onClose: () => void }) => {
  const { t } = useTranslation("settings")
  const id = useId()
  const [values, setValues] = useState(() => initialWebListValues(source))
  const actions = useWebListSourceActions()
  const pending = actions.create.isPending || actions.update.isPending
  const set = <K extends keyof WebListFormValues>(key: K, value: WebListFormValues[K]) =>
    setValues((current) => ({ ...current, [key]: value }))
  type TextKey = {
    [K in keyof WebListFormValues]: WebListFormValues[K] extends string ? K : never
  }[keyof WebListFormValues]
  const field = (key: TextKey, multiline = false, numeric?: { min: number; max?: number }) => (
    <label
      key={key}
      className="block space-y-1 text-xs text-text-secondary"
      htmlFor={`${id}-${key}`}
    >
      <span>{t(`web_list_sources.${key}`)}</span>
      {multiline ? (
        <textarea
          id={`${id}-${key}`}
          rows={3}
          className="w-full rounded-lg border border-fill-secondary bg-fill-quinary p-2 text-text"
          value={values[key]}
          onChange={(event) => set(key, event.target.value)}
        />
      ) : (
        <Input
          id={`${id}-${key}`}
          value={values[key]}
          type={numeric ? "number" : key === "targetURL" ? "url" : "text"}
          {...numeric}
          required={["name", "targetURL", "titlePath", "maxItems", "maxPages", "timeZone"].includes(
            key,
          )}
          placeholder={key === "timeZone" ? "Asia/Shanghai" : undefined}
          onChange={(event) => set(key, event.target.value)}
        />
      )}
    </label>
  )
  const toggle = (key: "enabled" | "detailEnabled") => (
    <div className="flex items-center justify-between gap-3 text-sm text-text">
      <label htmlFor={`${id}-${key}`}>{t(`web_list_sources.${key}`)}</label>
      <Switch
        id={`${id}-${key}`}
        checked={values[key]}
        onCheckedChange={(value) => set(key, value)}
      />
    </div>
  )
  return (
    <form
      className="space-y-4 rounded-xl border border-fill-secondary bg-material-ultra-thin p-4"
      onSubmit={async (event) => {
        event.preventDefault()
        try {
          if (source)
            await actions.update.mutateAsync({ id: source.id, patch: webListPatch(values) })
          else await actions.create.mutateAsync(webListInput(values))
          onClose()
        } catch (error) {
          toast.error(error instanceof Error ? error.message : t("web_list_sources.request_failed"))
        }
      }}
    >
      <h3 className="font-medium text-text">
        {t(source ? "web_list_sources.edit" : "web_list_sources.create")}
      </h3>
      <fieldset disabled={pending} className="space-y-4">
        {field("name")}
        {field("targetURL")}
        <label className="block space-y-1 text-xs text-text-secondary">
          <span>{t("web_list_sources.format")}</span>
          <select
            className="block w-full rounded-lg bg-fill-secondary p-2 text-text"
            value={values.format}
            onChange={(event) => set("format", event.target.value === "json" ? "json" : "html")}
          >
            <option value="html">HTML</option>
            <option value="json">JSON</option>
          </select>
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          {values.format === "html" ? (
            (
              [
                "itemSelector",
                "linkSelector",
                "titleSelector",
                "dateSelector",
                "summarySelector",
              ] as const
            ).map((key) => field(key))
          ) : (
            <>
              {(
                [
                  "itemsPath",
                  "titlePath",
                  "urlPath",
                  "urlTemplate",
                  "urlBase",
                  "idPath",
                  "summaryPath",
                  "publishedAtPath",
                ] as const
              ).map((key) => field(key))}
              <label className="block space-y-1 text-xs text-text-secondary">
                <span>{t("web_list_sources.publishedAtFormat")}</span>
                <select
                  className="block w-full rounded-lg bg-fill-secondary p-2 text-text"
                  value={values.publishedAtFormat}
                  onChange={(event) => {
                    const value = event.target.value
                    if (
                      value === "auto" ||
                      value === "unix_seconds" ||
                      value === "unix_milliseconds"
                    )
                      set("publishedAtFormat", value)
                  }}
                >
                  {(["auto", "unix_seconds", "unix_milliseconds"] as const).map((format) => (
                    <option key={format} value={format}>
                      {t(`web_list_sources.${format}`)}
                    </option>
                  ))}
                </select>
              </label>
              {field("metadataPaths", true)}
            </>
          )}
        </div>
        <details>
          <summary className="cursor-pointer text-sm text-text">
            {t("web_list_sources.filters")}
          </summary>
          <p className="my-2 text-xs text-text-secondary">{t("web_list_sources.lines_hint")}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            {(
              [
                "includeTextPatterns",
                "excludeTextPatterns",
                "includeURLPatterns",
                "excludeURLPatterns",
              ] as const
            ).map((key) => field(key, true))}
          </div>
        </details>
        {toggle("detailEnabled")}
        {values.detailEnabled && (
          <div className="grid gap-3 sm:grid-cols-2">
            {field("contentSelectors", true)}
            {field("ignoreSelectors", true)}
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          {field("maxItems", false, { min: 1, max: 100 })}
          {field("maxPages", false, { min: 1, max: 10 })}
          {field("timeZone")}
          {field("intervalMinutes", false, { min: 15 })}
        </div>
        <p className="text-xs text-text-secondary">{t("web_list_sources.schedule_hint")}</p>
        {toggle("enabled")}
      </fieldset>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" disabled={pending} onClick={onClose}>
          {t("web_list_sources.cancel")}
        </Button>
        <Button type="submit" disabled={pending} isLoading={pending}>
          {t("web_list_sources.save")}
        </Button>
      </div>
    </form>
  )
}

const SourceRow = ({ source }: { source: WebListSource }) => {
  const { t } = useTranslation("settings")
  const { present, dismissAll } = useModalStack()
  const actions = useWebListSourceActions()
  const [editing, setEditing] = useState(false)
  const [recent, setRecent] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [copying, setCopying] = useState(false)
  const items = useWebListItems(source.id, recent)
  const pending = Object.values(actions).some((action) => action.isPending)
  const run = async (work: () => Promise<unknown>) => {
    try {
      await work()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("web_list_sources.request_failed"))
    }
  }
  return (
    <article className="space-y-3 rounded-xl border border-fill-secondary p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="break-words font-medium text-text">{source.name}</h3>
          <span className="rounded bg-fill-secondary px-2 py-0.5 text-xs uppercase text-text-secondary">
            {source.format}
          </span>
        </div>
        <Switch
          aria-label={t("web_list_sources.enabled")}
          checked={source.enabled}
          disabled={pending}
          onCheckedChange={(enabled) =>
            void run(() =>
              actions.update.mutateAsync({
                id: source.id,
                patch: {
                  enabled,
                  ...(enabled && source.intervalMinutes === null ? { intervalMinutes: 360 } : {}),
                },
              }),
            )
          }
        />
      </div>
      <div className="grid gap-1 text-xs text-text-secondary sm:grid-cols-2">
        <p>
          {t("web_list_sources.intervalMinutes")}: {source.intervalMinutes ?? "—"}
        </p>
        <p>
          {t("web_list_sources.itemCount")}: {source.itemCount}
        </p>
        <p>
          {t("web_list_sources.lastSuccessAt")}: {time(source.lastSuccessAt)}
        </p>
        <p>
          {t("web_list_sources.nextCheckAt")}: {time(source.nextCheckAt)}
        </p>
      </div>
      {(source.lastErrorCode || source.lastErrorSummary) && (
        <p className="break-words text-xs text-red">
          {source.lastErrorCode}: {source.lastErrorSummary}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          isLoading={actions.check.isPending}
          onClick={() =>
            void run(async () => {
              const result = await actions.check.mutateAsync(source.id)
              toast.success(t("web_list_sources.published", { count: result.publishedCount }))
            })
          }
        >
          {t("web_list_sources.check")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={pending || editing}
          isLoading={actions.test.isPending}
          onClick={() => void run(() => actions.test.mutateAsync(source.id))}
        >
          {t("web_list_sources.test")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() => {
            setEditing(!editing)
            actions.test.reset()
          }}
        >
          {t("web_list_sources.edit")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={pending || copying}
          isLoading={copying}
          onClick={() =>
            void run(async () => {
              setCopying(true)
              try {
                await navigator.clipboard.writeText(source.feedURL)
                toast.success(t("web_list_sources.copied"))
              } finally {
                setCopying(false)
              }
            })
          }
        >
          {t("web_list_sources.copy")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() =>
            present({
              content: () => <FeedForm url={source.feedURL} onSuccess={dismissAll} />,
              title: t("web_list_sources.subscribe"),
            })
          }
        >
          {t("web_list_sources.subscribe")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setRecent(!recent)}
          aria-expanded={recent}
        >
          {t("web_list_sources.recent")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() => setConfirmDelete(true)}
        >
          {t("web_list_sources.delete")}
        </Button>
      </div>
      {confirmDelete && (
        <div role="alert" className="space-y-2 rounded-lg bg-fill-secondary p-3">
          <p className="text-sm text-text">
            {t("web_list_sources.delete_confirm", { name: source.name })}
          </p>
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={pending}
              isLoading={actions.delete.isPending}
              onClick={() => void run(() => actions.delete.mutateAsync(source.id))}
            >
              {t("web_list_sources.delete")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => setConfirmDelete(false)}
            >
              {t("web_list_sources.cancel")}
            </Button>
          </div>
        </div>
      )}
      {editing && <SourceEditor source={source} onClose={() => setEditing(false)} />}
      {actions.test.data && <TestPreview result={actions.test.data} />}
      {recent && (
        <div className="space-y-2 border-t border-fill-secondary pt-3">
          {items.isLoading && (
            <p role="status" className="text-xs text-text-secondary">
              {t("web_list_sources.loading")}
            </p>
          )}
          {items.isError && (
            <div role="alert" className="text-xs text-red">
              {items.error.message}
              <Button size="sm" variant="outline" onClick={() => void items.refetch()}>
                {t("web_list_sources.retry")}
              </Button>
            </div>
          )}
          {items.data?.items.length === 0 && (
            <p className="text-xs text-text-secondary">{t("web_list_sources.no_items")}</p>
          )}
          {items.data?.items.map((item) => (
            <div key={item.id} className="text-xs">
              <a
                className="break-words text-blue hover:underline"
                href={safeURL(item.url)}
                target="_blank"
                rel="noreferrer"
              >
                {item.title}
              </a>
              <p className="text-text-secondary">
                {t("web_list_sources.publishedAtPath")}: {time(item.publishedAt)} ·{" "}
                {t("web_list_sources.discoveredAt")}: {time(item.discoveredAt)}
              </p>
            </div>
          ))}
        </div>
      )}
    </article>
  )
}

export const SettingWebListSources = () => {
  const { t } = useTranslation("settings")
  const sources = useWebListSources()
  const [creating, setCreating] = useState(false)
  return (
    <section className="mt-6 space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-text">{t("web_list_sources.title")}</h2>
        <Button size="sm" disabled={creating} onClick={() => setCreating(true)}>
          {t("web_list_sources.create")}
        </Button>
      </div>
      <p className="text-xs text-text-secondary">{t("web_list_sources.description")}</p>
      {creating && <SourceEditor onClose={() => setCreating(false)} />}
      {sources.isLoading && (
        <p role="status" className="text-sm text-text-secondary">
          {t("web_list_sources.loading")}
        </p>
      )}
      {sources.isError && (
        <div role="alert" className="text-sm text-red">
          {sources.error.message}
          <Button variant="outline" onClick={() => void sources.refetch()}>
            {t("web_list_sources.retry")}
          </Button>
        </div>
      )}
      {sources.data?.sources.length === 0 && (
        <p className="rounded-xl border border-dashed border-fill p-8 text-center text-sm text-text-secondary">
          {t("web_list_sources.empty")}
        </p>
      )}
      {sources.data?.sources.map((source) => (
        <SourceRow key={source.id} source={source} />
      ))}
    </section>
  )
}

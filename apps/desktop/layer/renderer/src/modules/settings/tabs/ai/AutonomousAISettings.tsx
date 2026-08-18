import { Button } from "@follow/components/ui/button/index.js"
import { Input, TextArea } from "@follow/components/ui/input/index.js"
import { Label } from "@follow/components/ui/label/index.jsx"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"

import {
  aiProcessingClient,
  aiProcessingKeys,
  useProcessingConfiguration,
} from "~/modules/ai-processing"

const stringifyTaxonomy = (content: Record<string, unknown> | undefined) =>
  JSON.stringify(content ?? { categories: [] }, null, 2)

export const AutonomousAISettings = () => {
  const { t } = useTranslation("ai")
  const queryClient = useQueryClient()
  const configuration = useProcessingConfiguration()
  const [baseURL, setBaseURL] = useState("")
  const [model, setModel] = useState("")
  const [apiKey, setAPIKey] = useState("")
  const [profileName, setProfileName] = useState("default")
  const [profileDocument, setProfileDocument] = useState("")
  const [taxonomyName, setTaxonomyName] = useState("default")
  const [taxonomyDocument, setTaxonomyDocument] = useState('{\n  "categories": []\n}')

  useEffect(() => {
    const data = configuration.data
    if (!data) return
    setBaseURL(data.provider.base_url ?? "")
    setModel(data.provider.model ?? "")
    const profile = data.profiles.current
    if (profile) {
      setProfileName(profile.name)
      setProfileDocument(
        typeof profile.content.document === "string"
          ? profile.content.document
          : JSON.stringify(profile.content, null, 2),
      )
    }
    const taxonomy = data.taxonomies.current
    if (taxonomy) {
      setTaxonomyName(taxonomy.name)
      setTaxonomyDocument(stringifyTaxonomy(taxonomy.content))
    }
  }, [configuration.data])

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: aiProcessingKeys.configuration })
  const saveProvider = useMutation({
    mutationFn: () =>
      aiProcessingClient.saveProvider({ api_key: apiKey, base_url: baseURL, model }),
    onSuccess: async () => {
      setAPIKey("")
      await invalidate()
      toast.success(t("autonomous.provider.saved"))
    },
    onError: (error) => toast.error(error.message),
  })
  const deleteProvider = useMutation({
    mutationFn: () => aiProcessingClient.deleteProvider(),
    onSuccess: async () => {
      await invalidate()
      toast.success(t("autonomous.provider.deleted"))
    },
    onError: (error) => toast.error(error.message),
  })
  const saveProfile = useMutation({
    mutationFn: () =>
      aiProcessingClient.createProfile({
        content: { document: profileDocument },
        name: profileName,
      }),
    onSuccess: async () => {
      await invalidate()
      toast.success(t("autonomous.profile.saved"))
    },
    onError: (error) => toast.error(error.message),
  })
  const saveTaxonomy = useMutation({
    mutationFn: async () => {
      const parsed = JSON.parse(taxonomyDocument) as unknown
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(t("autonomous.taxonomy.invalid"))
      }
      return aiProcessingClient.createTaxonomy({
        content: parsed as Record<string, unknown>,
        name: taxonomyName,
      })
    },
    onSuccess: async () => {
      await invalidate()
      toast.success(t("autonomous.taxonomy.saved"))
    },
    onError: (error) => toast.error(error.message),
  })

  if (configuration.isLoading) {
    return (
      <div
        className="flex min-h-24 items-center justify-center text-text-secondary"
        data-testid="autonomous-ai-settings"
      >
        <i className="i-mgc-loading-3-cute-re size-5 animate-spin f-motion-reduce:animate-none" />
      </div>
    )
  }

  return (
    <div className="space-y-8" data-testid="autonomous-ai-settings">
      {configuration.isError && (
        <div role="alert" className="rounded-lg border border-red/30 bg-red/5 p-3 text-sm text-red">
          {configuration.error.message}
        </div>
      )}

      <section className="space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-sm font-semibold text-text">{t("autonomous.provider.title")}</h3>
            <p className="mt-1 text-xs leading-relaxed text-text-secondary">
              {t("autonomous.provider.description")}
            </p>
          </div>
          {configuration.data?.provider.configured && (
            <span className="shrink-0 rounded-full bg-green/10 px-2 py-1 text-xs font-medium text-green">
              {configuration.data.provider.key_source === "stored"
                ? t("autonomous.provider.stored", {
                    hint: configuration.data.provider.key_hint ?? "",
                  })
                : t("autonomous.provider.environment")}
            </span>
          )}
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="autonomous-ai-base-url">{t("autonomous.provider.base_url")}</Label>
            <Input
              id="autonomous-ai-base-url"
              type="url"
              value={baseURL}
              onChange={(event) => setBaseURL(event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="autonomous-ai-model">{t("autonomous.provider.model")}</Label>
            <Input
              id="autonomous-ai-model"
              value={model}
              onChange={(event) => setModel(event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="autonomous-ai-key">{t("autonomous.provider.api_key")}</Label>
            <Input
              id="autonomous-ai-key"
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={(event) => setAPIKey(event.target.value)}
            />
          </div>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          {configuration.data?.provider.key_source === "stored" && (
            <Button
              variant="ghost"
              disabled={deleteProvider.isPending}
              onClick={() => deleteProvider.mutate()}
            >
              {t("autonomous.provider.use_environment")}
            </Button>
          )}
          <Button
            disabled={saveProvider.isPending || !baseURL.trim() || !model.trim() || !apiKey.trim()}
            onClick={() => saveProvider.mutate()}
          >
            {t("autonomous.provider.save")}
          </Button>
        </div>
      </section>

      <section className="space-y-4 border-t border-fill-secondary pt-6">
        <div>
          <h3 className="text-sm font-semibold text-text">{t("autonomous.profile.title")}</h3>
          <p className="mt-1 text-xs leading-relaxed text-text-secondary">
            {t("autonomous.profile.description")}
          </p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="autonomous-profile-name">{t("autonomous.snapshot_name")}</Label>
          <Input
            id="autonomous-profile-name"
            value={profileName}
            onChange={(event) => setProfileName(event.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="autonomous-profile-document">{t("autonomous.profile.document")}</Label>
          <TextArea
            id="autonomous-profile-document"
            className="min-h-40 font-mono text-xs"
            value={profileDocument}
            onChange={(event) => setProfileDocument(event.target.value)}
          />
        </div>
        <div className="flex items-center justify-between gap-4">
          <span className="text-xs text-text-secondary">
            {t("autonomous.snapshot_count", {
              count: configuration.data?.profiles.snapshots.length ?? 0,
            })}
          </span>
          <Button
            disabled={saveProfile.isPending || !profileName.trim() || !profileDocument.trim()}
            onClick={() => saveProfile.mutate()}
          >
            {t("autonomous.profile.save")}
          </Button>
        </div>
      </section>

      <section className="space-y-4 border-t border-fill-secondary pt-6">
        <div>
          <h3 className="text-sm font-semibold text-text">{t("autonomous.taxonomy.title")}</h3>
          <p className="mt-1 text-xs leading-relaxed text-text-secondary">
            {t("autonomous.taxonomy.description")}
          </p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="autonomous-taxonomy-name">{t("autonomous.snapshot_name")}</Label>
          <Input
            id="autonomous-taxonomy-name"
            value={taxonomyName}
            onChange={(event) => setTaxonomyName(event.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="autonomous-taxonomy-document">{t("autonomous.taxonomy.document")}</Label>
          <TextArea
            id="autonomous-taxonomy-document"
            className="min-h-48 font-mono text-xs"
            value={taxonomyDocument}
            onChange={(event) => setTaxonomyDocument(event.target.value)}
          />
        </div>
        <div className="flex items-center justify-between gap-4">
          <span className="text-xs text-text-secondary">
            {t("autonomous.snapshot_count", {
              count: configuration.data?.taxonomies.snapshots.length ?? 0,
            })}
          </span>
          <Button
            disabled={saveTaxonomy.isPending || !taxonomyName.trim() || !taxonomyDocument.trim()}
            onClick={() => saveTaxonomy.mutate()}
          >
            {t("autonomous.taxonomy.save")}
          </Button>
        </div>
      </section>

      <section className="space-y-3 border-t border-fill-secondary pt-6">
        <h3 className="text-sm font-semibold text-text">{t("autonomous.processor.title")}</h3>
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="rounded-lg bg-fill-quaternary p-3">
            <div className="text-xs text-text-secondary">{t("autonomous.processor.name")}</div>
            <div className="mt-1 font-mono text-sm text-text">personal-relevance / v1</div>
          </div>
          <div className="rounded-lg bg-fill-quaternary p-3">
            <div className="text-xs text-text-secondary">{t("autonomous.processor.formula")}</div>
            <div className="mt-1 font-mono text-sm text-text">weighted-v1 · 30/20/50</div>
          </div>
        </div>
        <p className="text-xs leading-relaxed text-text-secondary">
          {t("autonomous.processor.description")}
        </p>
      </section>
    </div>
  )
}

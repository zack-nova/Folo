import { Button } from "@follow/components/ui/button/index.js"
import { Checkbox } from "@follow/components/ui/checkbox/index.jsx"
import { Label } from "@follow/components/ui/label/index.jsx"
import { useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"

import { useAIProcessingMutations } from "../queries"
import type { ReEvaluationScope } from "../types"

export const ReEvaluationModalContent = ({
  scope,
  dismiss,
}: {
  scope: ReEvaluationScope
  dismiss: () => void
}) => {
  const { t } = useTranslation()
  const mutations = useAIProcessingMutations()
  const [forceRerun, setForceRerun] = useState(false)
  const [preview, setPreview] = useState<
    Awaited<ReturnType<typeof mutations.previewReEvaluation.mutateAsync>> | undefined
  >()
  const effectiveScope = { ...scope, force_rerun: forceRerun }

  const handlePreview = async () => {
    try {
      setPreview(await mutations.previewReEvaluation.mutateAsync(effectiveScope))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("ai_processing.request_failed"))
    }
  }

  const handleSubmit = async () => {
    try {
      const result = await mutations.createReEvaluationJobs.mutateAsync(effectiveScope)
      toast.success(
        t("ai_processing.reevaluate.result", {
          created: result.created,
          reused: result.reused,
          satisfied: result.already_satisfied,
          skipped: result.skipped,
          superseded: result.superseded,
        }),
      )
      dismiss()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("ai_processing.request_failed"))
    }
  }

  return (
    <div className="min-w-[min(28rem,80vw)] space-y-5">
      <p className="text-sm leading-relaxed text-text-secondary">
        {t("ai_processing.reevaluate.description")}
      </p>
      <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border border-fill-secondary px-3 transition-colors duration-200 hover:bg-fill-quaternary">
        <Checkbox
          checked={forceRerun}
          onCheckedChange={(checked) => setForceRerun(checked === true)}
        />
        <span>
          <Label className="block text-sm">{t("ai_processing.reevaluate.force")}</Label>
          <span className="text-xs text-text-secondary">
            {t("ai_processing.reevaluate.force_description")}
          </span>
        </span>
      </label>

      {preview && (
        <div className="grid grid-cols-2 gap-2" aria-live="polite">
          {[
            [t("ai_processing.reevaluate.matched"), preview.matched],
            [t("ai_processing.reevaluate.estimated_calls"), preview.estimated_calls],
            [t("ai_processing.reevaluate.active"), preview.active],
            [t("ai_processing.reevaluate.satisfied"), preview.already_satisfied],
          ].map(([label, value]) => (
            <div key={String(label)} className="rounded-lg bg-fill-quaternary p-3">
              <div className="text-xs text-text-secondary">{label}</div>
              <div className="mt-1 text-lg font-semibold tabular-nums text-text">{value}</div>
            </div>
          ))}
        </div>
      )}

      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={dismiss}>
          {t("words.cancel", { ns: "common" })}
        </Button>
        {!preview ? (
          <Button disabled={mutations.previewReEvaluation.isPending} onClick={handlePreview}>
            {t("ai_processing.reevaluate.preview")}
          </Button>
        ) : (
          <Button disabled={mutations.createReEvaluationJobs.isPending} onClick={handleSubmit}>
            {t("ai_processing.reevaluate.confirm")}
          </Button>
        )}
      </div>
    </div>
  )
}

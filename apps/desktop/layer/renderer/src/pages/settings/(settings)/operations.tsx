import { getCapabilityManifest } from "~/atoms/capabilities"
import { SettingOperations } from "~/modules/settings/tabs/operations"
import { SettingsTitle } from "~/modules/settings/title"
import { defineSettingPageData } from "~/modules/settings/utils"

const iconName = "i-mgc-pulse-cute-re"
const priority = (1000 << 2) + 21

export const handle = defineSettingPageData({
  icon: iconName,
  name: "titles.operations",
  priority,
  hideIf: () => getCapabilityManifest()?.has("operations.stability") !== true,
})

export function Component() {
  return (
    <>
      <SettingsTitle />
      <SettingOperations />
    </>
  )
}

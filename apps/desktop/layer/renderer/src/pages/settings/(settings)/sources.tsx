import { getCapabilityManifest } from "~/atoms/capabilities"
import { SettingSources } from "~/modules/settings/tabs/sources"
import { SettingsTitle } from "~/modules/settings/title"
import { defineSettingPageData } from "~/modules/settings/utils"

const iconName = "i-mgc-plugin-2-cute-re"
const priority = (1000 << 2) + 22

export const handle = defineSettingPageData({
  icon: iconName,
  name: "titles.sources",
  priority,
  hideIf: () =>
    getCapabilityManifest()?.has("sources.route_catalog") !== true &&
    getCapabilityManifest()?.has("sources.web_list_management") !== true,
})

export function Component() {
  return (
    <>
      <SettingsTitle />
      <SettingSources />
    </>
  )
}

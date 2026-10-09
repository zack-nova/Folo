const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value)

const stringField = (value: unknown, key: string): string | null => {
  const field = isRecord(value) ? value[key] : undefined
  return typeof field === "string" && field ? field : null
}

const blockTypes = new Set(["heading", "listitem", "paragraph", "quote"])

const nodeText = (node: unknown): string => {
  if (!isRecord(node)) return ""
  switch (node.type) {
    case "text":
      return stringField(node, "text") ?? ""
    case "linebreak":
      return "\n"
    // Mentions and shortcuts print as their visible label, as in the client's own text export.
    case "mention":
      return stringField(node.mentionData, "text") ?? stringField(node.mentionData, "name") ?? ""
    case "shortcut":
      return (
        stringField(node.shortcutData, "prompt") ?? stringField(node.shortcutData, "name") ?? ""
      )
  }
  const children = Array.isArray(node.children) ? node.children.map(nodeText).join("") : ""
  return blockTypes.has(String(node.type)) ? `${children}\n` : children
}

/**
 * The task prompt as plain text. The client stores the serialized state of its rich text editor;
 * a prompt written through the API as plain text is used as is.
 */
export const taskPromptText = (prompt: string): string => {
  let state: unknown
  try {
    state = JSON.parse(prompt)
  } catch {
    return prompt.trim()
  }
  if (!isRecord(state) || !isRecord(state.root)) return prompt.trim()
  return nodeText(state.root)
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replaceAll(/\n{3,}/g, "\n\n")
    .trim()
}

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto"

const algorithm = "aes-256-gcm"
const version = "v1"

const encryptionKey = (secret: string) => createHash("sha256").update(secret).digest()

export const encryptCredential = (plaintext: string, secret: string): string => {
  const iv = randomBytes(12)
  const cipher = createCipheriv(algorithm, encryptionKey(secret), iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])
  const tag = cipher.getAuthTag()
  return [
    version,
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".")
}

export const decryptCredential = (encrypted: string, secret: string): string => {
  const [storedVersion, iv, tag, ciphertext] = encrypted.split(".")
  if (storedVersion !== version || !iv || !tag || !ciphertext) {
    throw new Error("Unsupported encrypted credential format")
  }
  const decipher = createDecipheriv(algorithm, encryptionKey(secret), Buffer.from(iv, "base64url"))
  decipher.setAuthTag(Buffer.from(tag, "base64url"))
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8")
}

export const credentialHint = (credential: string): string =>
  `…${credential.slice(Math.max(0, credential.length - 4))}`

export const normalizeProviderBaseURL = (value: string): string => {
  const url = new URL(value)
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("AI provider base URL must use HTTP or HTTPS")
  }
  if (url.username || url.password)
    throw new Error("AI provider base URL must not contain credentials")
  url.hash = ""
  url.search = ""
  return url.toString().replace(/\/$/, "")
}

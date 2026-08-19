import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"

export interface EncryptedCredentialValue {
  authenticationTag: Buffer
  ciphertext: Buffer
  initializationVector: Buffer
  keyId: string
}

const additionalData = (credentialId: string) =>
  Buffer.from(`folo-feed-supplier:credential:${credentialId}:v1`, "utf8")

export class CredentialCipher {
  constructor(
    private readonly activeKeyId: string,
    private readonly keys: ReadonlyMap<string, Buffer>,
  ) {
    if (!keys.has(activeKeyId)) throw new Error(`Credential key ${activeKeyId} is unavailable`)
  }

  get activeId(): string {
    return this.activeKeyId
  }

  encrypt(credentialId: string, value: string): EncryptedCredentialValue {
    const key = this.keys.get(this.activeKeyId)
    if (!key) throw new Error(`Credential key ${this.activeKeyId} is unavailable`)
    const initializationVector = randomBytes(12)
    const cipher = createCipheriv("aes-256-gcm", key, initializationVector)
    cipher.setAAD(additionalData(credentialId))
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()])
    return {
      authenticationTag: cipher.getAuthTag(),
      ciphertext,
      initializationVector,
      keyId: this.activeKeyId,
    }
  }

  decrypt(credentialId: string, encrypted: EncryptedCredentialValue): string {
    const key = this.keys.get(encrypted.keyId)
    if (!key) throw new Error(`Credential key ${encrypted.keyId} is unavailable`)
    const decipher = createDecipheriv("aes-256-gcm", key, encrypted.initializationVector)
    decipher.setAAD(additionalData(credentialId))
    decipher.setAuthTag(encrypted.authenticationTag)
    return Buffer.concat([decipher.update(encrypted.ciphertext), decipher.final()]).toString("utf8")
  }
}

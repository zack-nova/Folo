import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"

import { FollowClient } from "@follow-app/client-sdk"
import { memoryAdapter } from "better-auth/adapters/memory"
import { afterEach, describe, expect, it } from "vitest"

import { createAuth } from "../src/auth"
import { MemoryDataStore } from "../src/data/memory-store"
import { buildServer } from "../src/server"

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
)

describe("single-owner profile", () => {
  const servers: Array<{ close: () => Promise<void> }> = []
  const temporaryDirectories: string[] = []

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()))
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) => rm(directory, { force: true, recursive: true })),
    )
  })

  it("closes registration after the owner and serves editable profiles and avatars", async () => {
    const uploadsDirectory = await mkdtemp(`${tmpdir()}/folo-profile-`)
    temporaryDirectories.push(uploadsDirectory)
    const auth = createAuth({
      baseURL: "http://localhost:3000",
      database: memoryAdapter({ account: [], session: [], user: [], verification: [] }),
      secret: "profile-test-secret-that-is-at-least-32-characters",
      trustedOrigins: ["http://localhost:2233"],
    })
    const server = await buildServer({
      auth,
      clientOrigins: ["http://localhost:2233"],
      dataStore: new MemoryDataStore(),
      serverURL: "http://localhost:3000",
      uploadsDirectory,
    })
    servers.push(server)

    const registration = await server.inject({
      method: "POST",
      url: "/better-auth/sign-up/email",
      headers: { origin: "http://localhost:2233" },
      payload: {
        email: "owner@example.com",
        name: "Instance Owner",
        password: "correct-horse-battery-staple",
      },
    })
    expect(registration.statusCode).toBe(200)
    const userId = registration.json().user.id as string
    const cookie = registration.headers["set-cookie"]?.toString().split(";", 1)[0]
    expect(cookie).toBeTruthy()

    const secondRegistration = await server.inject({
      method: "POST",
      url: "/better-auth/sign-up/email",
      headers: { origin: "http://localhost:2233" },
      payload: {
        email: "intruder@example.com",
        name: "Second User",
        password: "correct-horse-battery-staple",
      },
    })
    expect(secondRegistration.statusCode).toBe(403)
    expect(secondRegistration.json()).toMatchObject({ code: "registration_closed" })

    const updated = await server.inject({
      method: "POST",
      url: "/better-auth/update-user",
      headers: { cookie: cookie!, origin: "http://localhost:2233" },
      payload: {
        bio: "A private feed library",
        handle: "owner",
        socialLinks: { github: "owner" },
        website: "https://example.com",
      },
    })
    expect(updated.statusCode).toBe(200)

    const client = new FollowClient({
      baseURL: "http://localhost:3000",
      fetch: async (input, init) => {
        const request = new Request(input, init)
        const response = await server.inject({
          method: request.method as "GET" | "POST",
          url: new URL(request.url).pathname + new URL(request.url).search,
          headers: { ...Object.fromEntries(request.headers.entries()), cookie: cookie! },
          payload:
            request.method === "GET" || request.method === "HEAD"
              ? undefined
              : Buffer.from(await request.arrayBuffer()),
        })
        return new Response(response.body, {
          status: response.statusCode,
          headers: response.headers as unknown as HeadersInit,
        })
      },
    })

    const profile = await client.api.profiles.getProfile({ id: userId })
    expect(profile.data).toMatchObject({
      id: userId,
      name: "Instance Owner",
      handle: "owner",
      bio: "A private feed library",
      website: "https://example.com",
      socialLinks: { github: "owner" },
    })
    expect((await client.api.profiles.getBatch({ ids: [userId] })).data[userId]).toMatchObject({
      handle: "owner",
    })

    const uploaded = await client.api.upload.uploadAvatar({
      file: new Blob([png], { type: "image/png" }),
    })
    expect(uploaded.url).toMatch(/^http:\/\/localhost:3000\/uploads\/avatars\/[a-f0-9]{64}\.png$/)
    const avatar = await server.inject({ method: "GET", url: new URL(uploaded.url).pathname })
    expect(avatar.statusCode).toBe(200)
    expect(avatar.headers["content-type"]).toContain("image/png")
    expect(avatar.rawPayload).toEqual(png)
    expect(await readFile(`${uploadsDirectory}/avatars/${uploaded.url.split("/").at(-1)}`)).toEqual(
      png,
    )

    const invalidForm = new FormData()
    invalidForm.append("file", new Blob(["not an image"], { type: "image/png" }), "avatar.png")
    const invalid = await client.api.upload
      .uploadAvatar({ file: invalidForm.get("file") as Blob })
      .then(
        () => null,
        (error: unknown) => error,
      )
    expect(invalid).toBeInstanceOf(Error)
  })
})

import { loadFeedSupplierConfig } from "./config"
import { buildFeedSupplier } from "./server"

const config = loadFeedSupplierConfig(process.env)
const server = await buildFeedSupplier({ config, logger: true })
await server.listen({ host: config.host, port: config.port })

let shuttingDown = false
const shutdown = async () => {
  if (shuttingDown) return
  shuttingDown = true
  await server.close()
}

process.once("SIGINT", () => void shutdown())
process.once("SIGTERM", () => void shutdown())

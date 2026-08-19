FROM node:22-bookworm-slim AS dependencies

ENV PNPM_HOME=/home/node/.local/share/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV COREPACK_HOME=/opt/corepack

RUN mkdir -p "$COREPACK_HOME" /build \
  && corepack enable \
  && corepack prepare pnpm@10.17.0 --activate \
  && chmod -R a+rX "$COREPACK_HOME" \
  && chown -R node:node /build

WORKDIR /build
COPY --chown=node:node apps/server/package.production.json ./package.json
COPY --chown=node:node apps/server/.npmrc.production ./.npmrc
COPY --chown=node:node apps/server/pnpm-workspace.production.yaml ./pnpm-workspace.yaml
COPY --chown=node:node apps/server/pnpm-lock.production.yaml ./pnpm-lock.yaml
COPY --chown=node:node patches/@mozilla__readability@0.6.0.patch ./patches/@mozilla__readability@0.6.0.patch
COPY --chown=node:node apps/server/package.json ./apps/server/package.json
COPY --chown=node:node packages/compat-contracts/package.json ./packages/compat-contracts/package.json
COPY --chown=node:node packages/readability/package.json ./packages/readability/package.json
USER node
RUN cd apps/server && pnpm pkg delete devDependencies \
  && cd ../../packages/compat-contracts && pnpm pkg delete devDependencies \
  && cd ../readability && pnpm pkg delete devDependencies
RUN --mount=type=cache,id=folo-server-pnpm,target=/pnpm/store,uid=1000,gid=1000 \
  pnpm --filter-prod @follow/server... install --frozen-lockfile --prod --ignore-scripts \
  --package-import-method=copy --store-dir=/pnpm/store

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production

RUN mkdir -p /app /data/uploads \
  && chown -R node:node /app /data

WORKDIR /app
COPY --from=dependencies --chown=node:node /build /app
COPY --chown=node:node apps/server/src ./apps/server/src
COPY --chown=node:node apps/server/drizzle ./apps/server/drizzle
COPY --chown=node:node packages/compat-contracts/src ./packages/compat-contracts/src
COPY --chown=node:node packages/compat-contracts/contracts ./packages/compat-contracts/contracts
COPY --chown=node:node packages/readability/src ./packages/readability/src

WORKDIR /app/apps/server
USER node

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["./node_modules/.bin/tsx", "--env-file-if-exists=.env", "src/index.ts"]

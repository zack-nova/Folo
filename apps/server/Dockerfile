FROM node:22-bookworm-slim

ENV PNPM_HOME=/home/node/.local/share/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV COREPACK_HOME=/opt/corepack
ENV NODE_ENV=production

RUN mkdir -p "$COREPACK_HOME" /data/uploads \
  && corepack enable \
  && corepack prepare pnpm@10.17.0 --activate \
  && chmod -R a+rX "$COREPACK_HOME" \
  && chown -R node:node /data

WORKDIR /app
COPY --chown=node:node . .
USER node
RUN pnpm install --frozen-lockfile --prod=false

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["pnpm", "--filter", "@follow/server", "start"]

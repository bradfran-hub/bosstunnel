FROM node:22-bookworm-slim
WORKDIR /app
COPY --chown=node:node package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --chown=node:node server.js check.cjs backup.cjs playback.js stream-policy.js ecosystem.config.cjs ./
COPY --chown=node:node LICENSE THIRD-PARTY.md BOSS-ADDON.md ./
COPY --chown=node:node public ./public
COPY --chown=node:node core ./core
COPY --chown=node:node sources ./sources
COPY --chown=node:node protocols ./protocols
RUN mkdir /app/data && chown node:node /app/data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s CMD node -e "const b=(process.env.BASE_PATH||'/bossmedia').replace(/\/$/,'');fetch('http://127.0.0.1:3000'+b+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["./node_modules/.bin/pm2-runtime", "ecosystem.config.cjs"]

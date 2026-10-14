FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY server.mjs profile.mjs events.mjs investigation.mjs calendar.mjs calendar-ews.mjs stands.mjs task-git.mjs hosts.mjs updater.mjs docker-updater.mjs calendar-exchange.ps1 hosts-elevated.ps1 index.html ./
RUN mkdir /data && chown node:node /data
ENV LK_LISTEN_HOST=0.0.0.0
ENV LK_DATA_DIR=/data
USER node
EXPOSE 18764
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "fetch('http://127.0.0.1:18764/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "server.mjs"]

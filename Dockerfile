FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY server.mjs profile.mjs events.mjs investigation.mjs index.html ./
COPY assets/anime-qa-duo.png ./assets/anime-qa-duo.png
RUN mkdir /data && chown node:node /data
ENV LK_LISTEN_HOST=0.0.0.0
ENV LK_DATA_DIR=/data
USER node
EXPOSE 18764
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "fetch('http://127.0.0.1:18764/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "server.mjs"]

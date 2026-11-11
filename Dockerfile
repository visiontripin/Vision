# ---------- сборка web ----------
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/package.json
COPY apps/console/package.json apps/console/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci --no-audit --no-fund
COPY . .
# веб-приложение и панель администрирования собираются вместе: обе отдаёт сервер
RUN npm run build && npm run build:console

# ---------- runtime ----------
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production \
    PORT=4000 \
    HOST=0.0.0.0 \
    DATA_DIR=/app/data
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/services/api ./services/api
COPY --from=build /app/apps/web/dist ./apps/web/dist
# панель администрирования отдаётся сервером по /admin (см. docs/adr/0009-server-console.md):
# без неё контейнер отвечает 503 с инструкцией, а мобильная панель остаётся отдельным APK
COPY --from=build /app/apps/console/dist ./apps/console/dist
# ffmpeg из apk: даёт opus/aac, loudnorm и HLS-нарезку (см. docs/RUNBOOK.md)
RUN apk add --no-cache ffmpeg \
 && mkdir -p /app/data/media /app/data/covers && chown -R node:node /app
USER node
EXPOSE 4000
VOLUME ["/app/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:4000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "services/api/src/start.js"]

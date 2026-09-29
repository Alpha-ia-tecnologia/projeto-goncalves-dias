# Imagem para hospedagem em contêiner (Easypanel, Docker). Gera o servidor Node
# standalone do vinext; a publicação no Cloudflare continua com `vinext deploy`.
# As chaves entram como variáveis de ambiente do serviço, nunca na imagem.
# Node 24 traz o npm 11, que gera o package-lock.json. O npm 10 do Node 22
# recusa esse lockfile: exige uma cópia própria do `ws`, peer opcional do
# `openai`, que o npm 11 dispensa.

FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
ENV DEPLOY_TARGET=node
RUN npm run build

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000
COPY --from=build --chown=node:node /app/dist/standalone ./
USER node
EXPOSE 3000
CMD ["node", "server.js"]

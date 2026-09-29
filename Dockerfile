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
# O proxy do Easypanel termina o HTTPS e repassa em HTTP. VINEXT_TRUST_PROXY
# faz o vinext montar a URL do pedido com o X-Forwarded-Proto (https); sem ele,
# a origem do app vira http:// e a API recusa os pedidos do navegador (403).
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    VINEXT_TRUST_PROXY=1
COPY --from=build --chown=node:node /app/dist/standalone ./
USER node
EXPOSE 3000
CMD ["node", "server.js"]

# Imagem para hospedagem em contêiner (Easypanel, Docker). Gera o servidor Node
# standalone do vinext; a publicação no Cloudflare continua com `vinext deploy`.
# As chaves entram como variáveis de ambiente do serviço, nunca na imagem.

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
ENV DEPLOY_TARGET=node
RUN npm run build

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000
COPY --from=build --chown=node:node /app/dist/standalone ./
USER node
EXPOSE 3000
CMD ["node", "server.js"]

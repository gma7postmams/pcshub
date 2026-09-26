FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev
COPY . .
RUN mkdir -p uploads/branding && chown -R node:node uploads
USER node
EXPOSE 3000
CMD ["node", "server.js"]

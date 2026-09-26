# Production image for ECS Fargate (plan §13.2). Build locally with: docker build -t rento-vroom-backend .

# Build: install everything and bundle the server and scripts with tsup
FROM node:22-bookworm-slim AS build
WORKDIR /app
# Tests don't run in the image, so skip mongodb-memory-server's MongoDB download
ENV MONGOMS_DISABLE_POSTINSTALL=1
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# Runtime: production dependencies and dist/ only, run as the non-root node user
FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
USER node
EXPOSE 4000
CMD ["node", "dist/server.js"]

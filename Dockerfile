# --- Build stage -------------------------------------------------------------
FROM node:20-alpine AS build
WORKDIR /app

COPY package.json package-lock.json* ./
# Use npm ci when a lockfile is present, fall back to install otherwise.
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# --- Runtime stage -----------------------------------------------------------
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

COPY --from=build /app/dist ./dist

EXPOSE 8787
USER node
CMD ["node", "dist/index.js"]

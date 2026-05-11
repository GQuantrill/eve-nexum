FROM node:20-alpine AS builder
RUN corepack enable && corepack prepare yarn@1.22.22 --activate
WORKDIR /app
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile
COPY . .
RUN yarn build

FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json ./
EXPOSE 3001
CMD ["node", "dist/src/index.js"]

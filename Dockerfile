FROM node:22-alpine AS build

WORKDIR /app

RUN apk add --no-cache openssl

# postinstall runs prisma generate, which needs the schema and a DATABASE_URL to
# load its config. It never connects, so a placeholder is enough at build time.
COPY package.json yarn.lock prisma.config.ts ./
COPY prisma ./prisma
RUN DATABASE_URL=postgresql://build:build@localhost:5432/build yarn install --frozen-lockfile --network-timeout 600000

COPY . .
RUN yarn build

FROM node:22-alpine AS runtime

WORKDIR /app

RUN apk add --no-cache openssl

ENV NODE_ENV=production
ENV PORT=3401

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/prisma.config.ts ./prisma.config.ts
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma

EXPOSE 3401

CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main"]

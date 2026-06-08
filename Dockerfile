# @author Maarten Haine
# @date 2026-03-03

FROM node:22-alpine

WORKDIR /app

COPY package*.json ./

RUN npm ci

COPY . .

RUN npm run build

EXPOSE 3000

CMD ["node", "build/simpledbmsd.mjs"]

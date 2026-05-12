FROM node:20-slim

RUN apt-get update && apt-get install -y libatomic1 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --legacy-peer-deps

COPY . .

EXPOSE 3001

CMD ["npm", "run", "server"]
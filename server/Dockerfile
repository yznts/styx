FROM node:latest

WORKDIR /app

COPY package*.json ./
RUN npm install
COPY ./server ./server

CMD ["npm", "run", "server"]

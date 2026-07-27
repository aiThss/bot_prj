FROM node:20-alpine

WORKDIR /app

COPY package*.json ./

RUN npm install --omit=dev

COPY . .

# Tạo thư mục chứa dữ liệu bền vững
RUN mkdir -p /app/data

VOLUME /app/data

EXPOSE 3000

CMD ["npm", "start"]

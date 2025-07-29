FROM node:20-slim

# Instala apenas o tzdata, que é útil para logs e operações com data/hora
RUN apt-get update && \
    apt-get install -y --no-install-recommends tzdata git ca-certificates && \
    ln -snf /usr/share/zoneinfo/America/Sao_Paulo /etc/localtime && \
    echo "America/Sao_Paulo" > /etc/timezone && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# O npm install agora será mais rápido e não precisará de ferramentas de build
COPY package*.json ./

# Isso evita a necessidade do openssh-client.
RUN git config --global url."https://github.com/".insteadOf "ssh://git@github.com/"

RUN npm install --omit=dev

COPY . .

# Comando final (ajustado para bater com o docker-compose.yml)
CMD ["node", "index.js"]
FROM node:20

# instala tzdata
RUN apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y tzdata && \
    ln -snf /usr/share/zoneinfo/America/Sao_Paulo /etc/localtime && \
    echo "America/Sao_Paulo" > /etc/timezone && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copie o package.json do diretório web e instale as dependências
COPY web/package*.json ./web/
WORKDIR /app/web
RUN npm install

# Volte para o diretório raiz do app e copie o resto
WORKDIR /app
COPY . .

# Defina o diretório de trabalho final e o comando
WORKDIR /app/web

CMD ["node", "server.js"]

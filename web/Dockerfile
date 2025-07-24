FROM node:20

# Instala todas as dependências do sistema em uma única camada
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      tzdata \
      python3 \
      make \
      g++ && \
    # Configura o fuso horário
    ln -snf /usr/share/zoneinfo/America/Sao_Paulo /etc/localtime && \
    echo "America/Sao_Paulo" > /etc/timezone && \
    # Limpa o cache para reduzir o tamanho da imagem
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app/web

# Copia apenas o package.json para aproveitar o cache do Docker
COPY ./web/package*.json ./
RUN npm install

# Copia o resto da aplicação web
COPY ./web .

CMD ["node", "server.js"]
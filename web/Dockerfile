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

# 1. Copia PRIMEIRO os arquivos de definição de pacotes
# O asterisco (*) garante que ele copie o package-lock.json se existir
COPY ./web/package*.json ./

# 2. Instala as dependências
# Como este passo vem antes de copiar o resto do código, o Docker usará o cache
# desta camada se o package.json não tiver mudado, acelerando builds futuros.
RUN npm install

# 3. Copia o restante do código da aplicação web
COPY ./web .

RUN npm install nodemailer

CMD ["node", "server.js"]
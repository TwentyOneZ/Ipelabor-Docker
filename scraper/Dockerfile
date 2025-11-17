FROM ghcr.io/puppeteer/puppeteer:22

# Usamos root para instalar dependências
USER root

# Trabalhamos na raiz do projeto dentro do container
WORKDIR /usr/src/app

# Copia TODO o projeto (raiz + pasta scraper, mqttClient.js, etc.)
COPY . .

# 1) Instala o mqtt na raiz, para ser usado por /usr/src/app/mqttClient.js
RUN npm install mqtt --omit=dev

# 2) Agora vamos para a pasta do scraper e instalamos as deps específicas dele
WORKDIR /usr/src/app/scraper
RUN npm install --omit=dev

# Ajusta permissões para o usuário padrão da imagem (pptruser)
RUN chown -R pptruser:pptruser /usr/src/app

# Roda em modo não-root
USER pptruser

# Comando padrão: rodar o scraper
CMD ["node", "scraper.js"]

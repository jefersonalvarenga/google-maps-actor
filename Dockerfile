# Use a imagem base do Apify com Node.js e Playwright
FROM apify/actor-node-playwright-chrome:20

# Copiar arquivos do projeto
COPY package*.json ./

# Instalar dependências
RUN npm install --include=dev

# Copiar o resto dos arquivos
COPY . ./

# Comando para iniciar o Actor
CMD npm start

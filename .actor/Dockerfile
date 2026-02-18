# Imagem oficial do Apify com Playwright + Chromium pré-instalado
FROM apify/actor-node-playwright-chrome:20

# Copiar dependências e instalar
COPY package*.json ./
RUN npm --quiet set progress=false \
    && npm install --only=prod --no-optional \
    && echo "NPM install done"

# Copiar o código fonte
COPY . ./

# Rodar o actor
CMD npm start

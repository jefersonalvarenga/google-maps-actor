# Google Maps Scraper Actor

Este Actor extrai dados de estabelecimentos do Google Maps usando uma lista de termos de busca em uma localização específica.

## Funcionalidades

- Busca múltiplos termos no Google Maps
- Extrai dados detalhados de cada estabelecimento
- Suporta configuração de localização e idioma
- Controle do número máximo de resultados por busca

## Dados Extraídos

Para cada estabelecimento, o Actor coleta:

- **name**: Nome do estabelecimento
- **rating**: Avaliação (estrelas)
- **reviewCount**: Número de avaliações
- **category**: Categoria do estabelecimento
- **address**: Endereço completo
- **phone**: Número de telefone
- **website**: Site oficial
- **url**: URL do Google Maps
- **searchTerm**: Termo de busca usado
- **location**: Localização da busca
- **scrapedAt**: Data e hora da extração

## Input

```json
{
  "searchTerms": ["clínica estética", "spa"],
  "location": "Campinas, SP, Brazil",
  "maxCrawledPlacesPerSearch": 20,
  "language": "pt-BR"
}
```

### Parâmetros

- **searchTerms** (obrigatório): Array de termos para buscar no Google Maps
- **location** (obrigatório): Cidade, estado e/ou país para a busca
- **maxCrawledPlacesPerSearch** (opcional): Número máximo de lugares por termo de busca (padrão: 20, máximo: 500)
- **language** (opcional): Código do idioma (padrão: "pt-BR")

## Output

Os dados são salvos no dataset do Actor e podem ser exportados em vários formatos (JSON, CSV, Excel, etc).

Exemplo de saída:

```json
{
  "searchTerm": "clínica estética",
  "location": "Campinas, SP, Brazil",
  "name": "Clínica Exemplo",
  "rating": "4.8",
  "reviewCount": "245",
  "category": "Clínica de estética",
  "address": "Rua Exemplo, 123 - Centro, Campinas - SP, 13010-000",
  "phone": "(19) 3234-5678",
  "website": "https://clinicaexemplo.com.br",
  "url": "https://www.google.com/maps/place/...",
  "scrapedAt": "2024-01-15T10:30:00.000Z"
}
```

## Como usar no Apify

### 1. Deploy do Actor

1. Faça login na sua conta Apify
2. Vá em "Actors" > "Create new"
3. Selecione "Import from GitHub" ou faça upload dos arquivos
4. O Apify detectará automaticamente a configuração

### 2. Executar localmente (para testes)

```bash
# Instalar dependências
npm install

# Criar arquivo de input para teste
echo '{
  "searchTerms": ["clínica estética"],
  "location": "Campinas, SP, Brazil",
  "maxCrawledPlacesPerSearch": 5,
  "language": "pt-BR"
}' > input.json

# Executar
apify run
```

### 3. Executar na plataforma Apify

1. Acesse seu Actor no Apify Console
2. Clique em "Try it"
3. Preencha o formulário de input
4. Clique em "Start"

## Dicas de uso

- **Performance**: Para buscas grandes, divida em múltiplas execuções
- **Rate limiting**: O Google Maps pode bloquear requisições muito rápidas. O Actor já inclui delays apropriados
- **Precisão da localização**: Seja específico na localização para melhores resultados
- **Múltiplos termos**: Use termos relacionados para cobrir mais estabelecimentos

## Limitações

- O Google Maps pode ter restrições de acesso dependendo do volume de requisições
- Alguns estabelecimentos podem não ter todos os dados disponíveis
- A estrutura do HTML do Google Maps pode mudar, necessitando atualizações do Actor

## Arquitetura

```
google-maps-actor/
├── .actor/
│   └── actor.json          # Configuração do Actor
├── main.js                 # Código principal
├── package.json            # Dependências
├── INPUT_SCHEMA.json       # Schema de input para UI
└── README.md              # Documentação
```

## Tecnologias

- **Apify SDK**: Framework para web scraping
- **Playwright**: Automação do navegador
- **Node.js**: Runtime JavaScript

## Suporte

Para problemas ou sugestões, abra uma issue no repositório do projeto.

import { Actor } from 'apify';
import { chromium } from 'playwright';

await Actor.init();

// Função para parsear endereço completo
function parseAddress(fullAddress) {
    if (!fullAddress) return {};

    const addressParts = {
        street: null,
        city: null,
        state: null,
        postal_code: null,
        country_code: null,
        full_address: fullAddress
    };

    try {
        // Pattern: "Rua X, 123 - Bairro, Cidade - Estado, CEP, País"
        const parts = fullAddress.split(',').map(p => p.trim());

        if (parts.length >= 2) {
            // Rua (primeira parte)
            addressParts.street = parts[0];

            // Última parte geralmente é o país
            if (parts[parts.length - 1]) {
                const lastPart = parts[parts.length - 1];
                if (lastPart.includes('Brasil') || lastPart.includes('Brazil')) {
                    addressParts.country_code = 'BR';
                }
            }

            // Procurar por CEP e estado
            for (let i = 1; i < parts.length; i++) {
                const part = parts[i];

                // CEP brasileiro: 12345-678
                const cepMatch = part.match(/\d{5}-\d{3}/);
                if (cepMatch) {
                    addressParts.postal_code = cepMatch[0];
                }

                // Estado (sigla antes do CEP): "Campinas - SP"
                const stateMatch = part.match(/\s-\s([A-Z]{2})\b/);
                if (stateMatch) {
                    addressParts.state = stateMatch[1];
                    // Cidade é o que vem antes do estado
                    const cityMatch = part.split('-')[0].trim();
                    if (cityMatch) {
                        addressParts.city = cityMatch;
                    }
                }
            }
        }
    } catch (error) {
        console.log('Erro ao parsear endereço:', error.message);
    }

    return addressParts;
}

// Função para limpar e converter valores numéricos
function cleanNumericValue(value) {
    if (!value) return null;
    if (typeof value === 'number') return value;

    // Remover pontos de milhar e converter vírgula em ponto
    const cleaned = value.toString().replace(/\./g, '').replace(',', '.');
    const number = parseFloat(cleaned);

    return isNaN(number) ? null : number;
}

// Função para tentar fechar popups e modais
async function closePopups(page) {
    try {
        // Tentar fechar cookie consent
        const cookieButton = await page.$('button[aria-label*="Aceitar"], button[aria-label*="Accept"], button:has-text("Aceitar tudo")');
        if (cookieButton) {
            await cookieButton.click();
            await page.waitForTimeout(500);
        }

        // Tentar fechar outros modais comuns
        const closeButtons = await page.$$('button[aria-label*="Fechar"], button[aria-label*="Close"], button[aria-label="Dispensar"]');
        for (const button of closeButtons) {
            try {
                await button.click({ timeout: 500 });
            } catch (e) {
                // Ignorar se não conseguir clicar
            }
        }
    } catch (e) {
        // Ignorar erros ao tentar fechar popups
    }
}

// Função para esperar e extrair dados de um lugar
async function extractPlaceData(page) {
    try {
        // Tentar fechar popups primeiro
        await closePopups(page);

        // Tentar esperar por múltiplos seletores (fallback strategy)
        try {
            await page.waitForSelector('[role="main"]', { timeout: 10000 });
        } catch (e) {
            // Se role="main" não aparecer, tentar esperar pelo título
            console.log('Seletor [role="main"] não encontrado, tentando alternativa...');
            await page.waitForSelector('h1.DUwDvf, h1[class*="fontHeadline"]', { timeout: 5000 });
        }

        const placeData = await page.evaluate(() => {
            const data = {};

            // Nome
            const nameElement = document.querySelector('h1.DUwDvf');
            data.name = nameElement ? nameElement.innerText : null;

            // Avaliação
            const ratingElement = document.querySelector('div.F7nice span[aria-hidden="true"]');
            data.rating = ratingElement ? ratingElement.innerText : null;

            // Número de avaliações
            // Tentar múltiplos seletores para suportar diferentes idiomas
            let reviewCountElement = document.querySelector('div.F7nice span[aria-label*="avalia"]') || // Português
                                     document.querySelector('div.F7nice span[aria-label*="review"]') || // Inglês
                                     document.querySelector('div.F7nice span[aria-label*="reseña"]') || // Espanhol
                                     document.querySelector('button[aria-label*="avalia"]') ||
                                     document.querySelector('button[aria-label*="review"]');

            if (reviewCountElement) {
                const ariaLabel = reviewCountElement.getAttribute('aria-label');
                // Extrair números (ex: "4,5 estrelas 1.234 avaliações" -> ["4", "5", "1", "234"])
                const matches = ariaLabel.match(/[\d.]+/g);
                if (matches && matches.length > 0) {
                    // Pegar o último número que geralmente é o total de avaliações
                    data.reviews_count = matches[matches.length - 1];
                }
            }

            // Fallback: tentar pegar do texto visível próximo ao rating
            if (!data.reviews_count) {
                const reviewTexts = Array.from(document.querySelectorAll('div.F7nice *'));
                for (const el of reviewTexts) {
                    const text = el.textContent || '';
                    // Procurar padrões como "(1.234)" ou "1.234 avaliações"
                    const match = text.match(/\(?([\d.]+)\)?(?:\s*(?:avalia|review|reseña))?/i);
                    if (match && match[1] && match[1].length >= 2) {
                        data.reviews_count = match[1];
                        break;
                    }
                }
            }

            // Categorias (pode ter múltiplas)
            const categoryElements = document.querySelectorAll('button[jsaction*="category"]');
            data.categories = [];
            categoryElements.forEach(el => {
                const text = el.innerText.trim();
                if (text && !data.categories.includes(text)) {
                    data.categories.push(text);
                }
            });

            // Endereço completo
            const addressElement = document.querySelector('button[data-item-id*="address"] div.fontBodyMedium');
            data.full_address = addressElement ? addressElement.innerText : null;

            // Telefone
            const phoneElement = document.querySelector('button[data-item-id*="phone"] div.fontBodyMedium');
            data.phone = phoneElement ? phoneElement.innerText : null;

            // Website
            const websiteElement = document.querySelector('a[data-item-id*="authority"]');
            data.website = websiteElement ? websiteElement.href : null;

            // CID - Customer ID (formato hex: 0xABC:0xDEF)
            data.cid = null;
            const cidMatch = window.location.href.match(/!1s(0x[0-9a-fA-F]+:0x[0-9a-fA-F]+)/);
            if (cidMatch) {
                data.cid = cidMatch[1];
            }

            // Place ID oficial da Google Places API (formato: ChIJ...)
            // Extrair do estado JavaScript da página (mais confiável que URL)
            data.place_id = null;

            try {
                // Método 1: Extrair de APP_INITIALIZATION_STATE
                if (window.APP_INITIALIZATION_STATE) {
                    const stateString = JSON.stringify(window.APP_INITIALIZATION_STATE);
                    const placeIdMatch = stateString.match(/"ChIJ[\w-]+"/g);
                    if (placeIdMatch && placeIdMatch.length > 0) {
                        // Pegar o primeiro PlaceId encontrado e remover aspas
                        data.place_id = placeIdMatch[0].replace(/"/g, '');
                    }
                }

                // Método 2: Extrair de _pageData (fallback)
                if (!data.place_id && window._pageData) {
                    const pageDataString = JSON.stringify(window._pageData);
                    const placeIdMatch = pageDataString.match(/"ChIJ[\w-]+"/g);
                    if (placeIdMatch && placeIdMatch.length > 0) {
                        data.place_id = placeIdMatch[0].replace(/"/g, '');
                    }
                }

                // Método 3: Buscar em todos os scripts da página
                if (!data.place_id) {
                    const scripts = Array.from(document.querySelectorAll('script'));
                    for (const script of scripts) {
                        if (script.textContent) {
                            const placeIdMatch = script.textContent.match(/ChIJ[\w-]{20,}/);
                            if (placeIdMatch) {
                                data.place_id = placeIdMatch[0];
                                break;
                            }
                        }
                    }
                }

                // Método 4: Fallback para URL (último recurso)
                if (!data.place_id) {
                    const urlMatch = window.location.href.match(/ChIJ[\w-]+/);
                    if (urlMatch) {
                        data.place_id = urlMatch[0];
                    }
                }
            } catch (e) {
                console.log('Erro ao extrair Place ID:', e.message);
            }

            // Knowledge Graph ID (formato: /g/11...)
            data.knowledge_graph_id = null;
            const kgmidMatch = window.location.href.match(/!16s%2Fg%2F([a-zA-Z0-9_-]+)/);
            if (kgmidMatch) {
                data.knowledge_graph_id = `/g/${kgmidMatch[1]}`;
            }

            // Latitude e Longitude (extrair da URL)
            // Formato: /@-22.8925795,-47.0487806,17z
            data.latitude = null;
            data.longitude = null;
            const coordMatch = window.location.href.match(/@(-?\d+\.\d+),(-?\d+\.\d+),/);
            if (coordMatch) {
                data.latitude = coordMatch[1];
                data.longitude = coordMatch[2];
            }

            // Price Level (extrair símbolo de $)
            // Pode aparecer como $, $$, $$$, $$$$
            data.price_level = null;
            const priceLevelElement = document.querySelector('span[aria-label*="Preço:"], span[aria-label*="Price:"]');
            if (priceLevelElement) {
                const priceText = priceLevelElement.getAttribute('aria-label');
                const priceMatch = priceText.match(/\$+/);
                if (priceMatch) {
                    data.price_level = priceMatch[0];
                }
            }

            // Services/Opções (delivery, dine-in, etc)
            data.services = [];
            const serviceElements = document.querySelectorAll('div[aria-label*="opções"], div[class*="accessibility"], button[aria-label]');
            serviceElements.forEach(el => {
                const ariaLabel = el.getAttribute('aria-label');
                if (ariaLabel) {
                    // Procurar por palavras-chave de serviços
                    if (/entrega|delivery/i.test(ariaLabel)) {
                        data.services.push('delivery');
                    }
                    if (/retirada|takeout|para viagem/i.test(ariaLabel)) {
                        data.services.push('takeout');
                    }
                    if (/consumo no local|dine.?in/i.test(ariaLabel)) {
                        data.services.push('dine-in');
                    }
                    if (/acessível.*cadeira|wheelchair/i.test(ariaLabel)) {
                        data.services.push('wheelchair-accessible');
                    }
                }
            });
            // Remover duplicatas
            data.services = [...new Set(data.services)];

            // Rating Distribution (distribuição de estrelas)
            data.rating_distribution = null;
            try {
                // Procurar pela seção de reviews que contém os gráficos de barras
                const ratingBars = document.querySelectorAll('tr[aria-label*="estrela"], tr[aria-label*="star"]');
                if (ratingBars.length > 0) {
                    const distribution = {};
                    ratingBars.forEach(bar => {
                        const label = bar.getAttribute('aria-label');
                        // Extrair: "5 estrelas, 70%" ou "5 stars, 70%"
                        const match = label.match(/(\d)\s+\w+,\s*(\d+)%/);
                        if (match) {
                            const stars = match[1];
                            const percentage = parseInt(match[2], 10);
                            distribution[`${stars}stars`] = percentage;
                        }
                    });
                    if (Object.keys(distribution).length > 0) {
                        data.rating_distribution = distribution;
                    }
                }
            } catch (e) {
                // Ignorar erros na extração de rating distribution
            }

            // Business Status (verificar se está permanentemente fechado)
            data.business_status = 'OPERATIONAL';
            const closedPermanentlyElement = document.querySelector('[class*="closed"], [aria-label*="Permanentemente fechado"], [aria-label*="Permanently closed"]');
            if (closedPermanentlyElement) {
                const text = closedPermanentlyElement.innerText || closedPermanentlyElement.getAttribute('aria-label');
                if (/permanentemente fechado|permanently closed/i.test(text)) {
                    data.business_status = 'CLOSED_PERMANENTLY';
                } else if (/temporariamente fechado|temporarily closed/i.test(text)) {
                    data.business_status = 'CLOSED_TEMPORARILY';
                }
            }

            // URL do Google Maps
            data.google_maps_url = window.location.href;

            return data;
        });

        // Processar dados no Node.js (fora do browser context)
        if (placeData) {
            // Converter rating para número
            if (placeData.rating) {
                placeData.rating = cleanNumericValue(placeData.rating);
            }

            // Converter reviews_count para número
            if (placeData.reviews_count) {
                placeData.reviews_count = parseInt(placeData.reviews_count.replace(/\D/g, ''), 10) || null;
            }

            // Converter latitude e longitude para números
            if (placeData.latitude) {
                placeData.latitude = parseFloat(placeData.latitude);
            }
            if (placeData.longitude) {
                placeData.longitude = parseFloat(placeData.longitude);
            }

            // Parsear endereço
            if (placeData.full_address) {
                const addressParts = parseAddress(placeData.full_address);
                Object.assign(placeData, addressParts);
            }

            // Adicionar categoria principal
            if (placeData.categories && placeData.categories.length > 0) {
                placeData.category_primary = placeData.categories[0];
            }
        }

        return placeData;
    } catch (error) {
        console.log('Erro ao extrair dados do lugar:', error.message);
        return null;
    }
}

// Função para fazer scroll na lista de resultados
async function scrollResults(page, maxPlaces) {
    const resultsSelector = 'div[role="feed"]';

    console.log(`📜 Iniciando scroll para carregar até ${maxPlaces} lugares...`);

    try {
        await page.waitForSelector(resultsSelector, { timeout: 10000 });

        let previousHeight = 0;
        let scrollAttempts = 0;
        const maxScrollAttempts = 100; // Aumentado de 50 para 100

        while (scrollAttempts < maxScrollAttempts) {
            const currentCount = await page.evaluate((selector) => {
                const feed = document.querySelector(selector);
                return feed ? feed.querySelectorAll('div.Nv2PK').length : 0;
            }, resultsSelector);

            // Log a cada 10 scrolls
            if (scrollAttempts % 10 === 0 || currentCount >= maxPlaces) {
                console.log(`   Scroll ${scrollAttempts}: ${currentCount} lugares carregados (meta: ${maxPlaces})`);
            }

            if (currentCount >= maxPlaces) {
                console.log(`✅ Limite atingido: ${currentCount} lugares`);
                break;
            }

            await page.evaluate((selector) => {
                const feed = document.querySelector(selector);
                if (feed) {
                    feed.scrollTo(0, feed.scrollHeight);
                }
            }, resultsSelector);

            await page.waitForTimeout(2000);

            const newHeight = await page.evaluate((selector) => {
                const feed = document.querySelector(selector);
                return feed ? feed.scrollHeight : 0;
            }, resultsSelector);

            if (newHeight === previousHeight) {
                console.log(`⚠️  Fim da lista alcançado com ${currentCount} lugares (menos que meta de ${maxPlaces})`);
                break;
            }

            previousHeight = newHeight;
            scrollAttempts++;
        }

        if (scrollAttempts >= maxScrollAttempts) {
            console.log(`⚠️  Limite de tentativas de scroll atingido (${maxScrollAttempts})`);
        }
    } catch (error) {
        console.log('❌ Erro ao fazer scroll:', error.message);
    }
}

// Função principal
try {
    const input = await Actor.getInput();

    // Validação do input
    if (!input || !input.searchTerms || !Array.isArray(input.searchTerms) || input.searchTerms.length === 0) {
        throw new Error('searchTerms é obrigatório e deve ser um array não vazio');
    }

    if (!input.location) {
        throw new Error('location é obrigatório');
    }

    const {
        searchTerms,
        location,
        maxCrawledPlacesPerSearch = 20,
        language = 'pt-BR',
        userData = {}
    } = input;

    console.log(`\n🚀 Iniciando scraping`);
    console.log(`   📍 Localização: ${location}`);
    console.log(`   🔍 Termos de busca: ${searchTerms.length} termo(s)`);
    console.log(`   📊 Máximo por busca: ${maxCrawledPlacesPerSearch} lugares`);
    console.log(`   🌐 Idioma: ${language}\n`);

    // Inicializar navegador
    const browser = await chromium.launch({
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-blink-features=AutomationControlled'
        ]
    });

    const context = await browser.newContext({
        locale: language,
        viewport: { width: 1920, height: 1080 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });

    const page = await context.newPage();

    // Adicionar headers para parecer mais natural
    await page.setExtraHTTPHeaders({
        'Accept-Language': language
    });

    const allResults = [];

    // Iterar sobre cada termo de busca
    for (const searchTerm of searchTerms) {
        console.log(`\n=== Buscando: "${searchTerm}" em ${location} ===`);

        // Construir URL de busca
        const searchQuery = `${searchTerm} ${location}`;
        const searchUrl = `https://www.google.com/maps/search/${encodeURIComponent(searchQuery)}`;

        try {
            // Tentar diferentes estratégias de carregamento
            console.log(`Navegando para: ${searchUrl}`);

            try {
                await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
            } catch (gotoError) {
                console.log(`Tentando estratégia alternativa de carregamento...`);
                await page.goto(searchUrl, { waitUntil: 'load', timeout: 60000 });
            }

            await page.waitForTimeout(5000);

            // Fazer scroll para carregar mais resultados
            await scrollResults(page, maxCrawledPlacesPerSearch);

            // Obter links dos resultados
            const placeLinks = await page.evaluate((maxPlaces) => {
                const links = [];
                const elements = document.querySelectorAll('a[href*="/maps/place/"]');

                for (let i = 0; i < Math.min(elements.length, maxPlaces); i++) {
                    const href = elements[i].href;
                    if (href && !links.includes(href)) {
                        links.push(href);
                    }
                }

                return links;
            }, maxCrawledPlacesPerSearch);

            console.log(`Encontrados ${placeLinks.length} lugares para "${searchTerm}"`);

            // Visitar cada lugar e extrair dados
            for (let i = 0; i < placeLinks.length; i++) {
                const link = placeLinks[i];
                console.log(`[${i + 1}/${placeLinks.length}] Extraindo dados de: ${link}`);

                try {
                    await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 45000 });

                    // Esperar um pouco mais para garantir que o conteúdo carregue
                    await page.waitForTimeout(4000);

                    const placeData = await extractPlaceData(page);

                    if (placeData && placeData.name) {
                        const result = {
                            search_term: searchTerm,
                            location,
                            ...placeData,
                            ...userData,
                            scraped_at: new Date().toISOString()
                        };

                        allResults.push(result);
                        await Actor.pushData(result);
                        console.log(`✓ ${placeData.name} (${placeData.rating || 'N/A'} ⭐)`);
                    } else {
                        console.log(`⚠️  Lugar sem dados válidos (nome não encontrado)`);
                    }
                } catch (error) {
                    console.log(`❌ Erro ao processar lugar: ${error.message}`);
                    // Continuar para o próximo lugar mesmo com erro
                }
            }

        } catch (error) {
            console.log(`Erro ao processar termo "${searchTerm}":`, error.message);
        }
    }

    await browser.close();

    console.log(`\n=== Scraping concluído ===`);
    console.log(`Total de lugares extraídos: ${allResults.length}`);

} catch (error) {
    console.error('Erro fatal:', error);
    throw error;
}

await Actor.exit();

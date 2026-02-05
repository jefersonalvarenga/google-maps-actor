import { Actor } from 'apify';
import { chromium } from 'playwright';

await Actor.init();

// Função para esperar e extrair dados de um lugar
async function extractPlaceData(page) {
    try {
        await page.waitForSelector('[role="main"]', { timeout: 5000 });

        const placeData = await page.evaluate(() => {
            const data = {};

            // Nome
            const nameElement = document.querySelector('h1.DUwDvf');
            data.name = nameElement ? nameElement.innerText : null;

            // Avaliação
            const ratingElement = document.querySelector('div.F7nice span[aria-hidden="true"]');
            data.rating = ratingElement ? ratingElement.innerText : null;

            // Número de avaliações
            const reviewCountElement = document.querySelector('div.F7nice span[aria-label*="avalia"]');
            if (reviewCountElement) {
                const match = reviewCountElement.getAttribute('aria-label').match(/\d+/);
                data.reviewCount = match ? match[0] : null;
            }

            // Categoria
            const categoryElement = document.querySelector('button[jsaction*="category"]');
            data.category = categoryElement ? categoryElement.innerText : null;

            // Endereço
            const addressElement = document.querySelector('button[data-item-id*="address"] div.fontBodyMedium');
            data.address = addressElement ? addressElement.innerText : null;

            // Telefone
            const phoneElement = document.querySelector('button[data-item-id*="phone"] div.fontBodyMedium');
            data.phone = phoneElement ? phoneElement.innerText : null;

            // Website
            const websiteElement = document.querySelector('a[data-item-id*="authority"]');
            data.website = websiteElement ? websiteElement.href : null;

            // URL do Google Maps
            data.url = window.location.href;

            return data;
        });

        return placeData;
    } catch (error) {
        console.log('Erro ao extrair dados do lugar:', error.message);
        return null;
    }
}

// Função para fazer scroll na lista de resultados
async function scrollResults(page, maxPlaces) {
    const resultsSelector = 'div[role="feed"]';

    try {
        await page.waitForSelector(resultsSelector, { timeout: 10000 });

        let previousHeight = 0;
        let scrollAttempts = 0;
        const maxScrollAttempts = 50;

        while (scrollAttempts < maxScrollAttempts) {
            const currentCount = await page.evaluate((selector) => {
                const feed = document.querySelector(selector);
                return feed ? feed.querySelectorAll('div.Nv2PK').length : 0;
            }, resultsSelector);

            if (currentCount >= maxPlaces) {
                console.log(`Encontrados ${currentCount} lugares, limite atingido`);
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
                console.log('Fim da lista de resultados');
                break;
            }

            previousHeight = newHeight;
            scrollAttempts++;
        }
    } catch (error) {
        console.log('Erro ao fazer scroll:', error.message);
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
        language = 'pt-BR'
    } = input;

    console.log(`Iniciando scraping com ${searchTerms.length} termo(s) de busca em ${location}`);

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
                    await page.waitForTimeout(3000);

                    const placeData = await extractPlaceData(page);

                    if (placeData && placeData.name) {
                        const result = {
                            searchTerm,
                            location,
                            ...placeData,
                            scrapedAt: new Date().toISOString()
                        };

                        allResults.push(result);
                        await Actor.pushData(result);
                        console.log(`✓ ${placeData.name}`);
                    }
                } catch (error) {
                    console.log(`Erro ao processar lugar: ${error.message}`);
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

import { Actor } from 'apify';
import { chromium } from 'playwright';

await Actor.init();

// ─── Helpers ────────────────────────────────────────────────────────────────

function cleanNumericValue(value) {
    if (!value) return null;
    if (typeof value === 'number') return value;
    const cleaned = value.toString().replace(/\./g, '').replace(',', '.');
    const number = parseFloat(cleaned);
    return isNaN(number) ? null : number;
}

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
        const parts = fullAddress.split(',').map(p => p.trim());
        if (parts.length >= 2) {
            addressParts.street = parts[0];
            const lastPart = parts[parts.length - 1];
            if (lastPart.includes('Brasil') || lastPart.includes('Brazil')) {
                addressParts.country_code = 'BR';
            }
            for (let i = 1; i < parts.length; i++) {
                const part = parts[i];
                const cepMatch = part.match(/\d{5}-\d{3}/);
                if (cepMatch) addressParts.postal_code = cepMatch[0];
                const stateMatch = part.match(/\s-\s([A-Z]{2})\b/);
                if (stateMatch) {
                    addressParts.state = stateMatch[1];
                    const cityMatch = part.split('-')[0].trim();
                    if (cityMatch) addressParts.city = cityMatch;
                }
            }
        }
    } catch (e) {}
    return addressParts;
}

// Faz fetch com headers que imitam um browser real
async function fetchPage(url, language = 'pt-BR') {
    const langCode = language.split('-')[0];
    const response = await fetch(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept-Language': `${language},${langCode};q=0.9,en;q=0.8`,
            'Accept': 'text/html,application/xhtml+xml,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Cache-Control': 'no-cache',
        }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} para ${url}`);
    return response.text();
}

// Extrai o APP_INITIALIZATION_STATE do HTML cru
function extractAppState(html) {
    // O Google Maps embute os dados em window.APP_INITIALIZATION_STATE = [...]
    const match = html.match(/window\.APP_INITIALIZATION_STATE\s*=\s*(\[.+?\]);\s*window\.APP_FLAGS/s);
    if (!match) return null;
    try {
        return JSON.parse(match[1]);
    } catch (e) {
        return null;
    }
}

// Monta a URL canônica do Google Maps para um place_id
function buildPlaceUrl(placeId) {
    return `https://www.google.com/maps/search/?api=1&query_place_id=${placeId}`;
}

// Parseia a resposta JSON do Google Maps (/search?tbm=map)
// O Google retorna )]}' seguido de JSON com os dados dos lugares
function extractPlaceIdsFromSearchResponse(body, maxPlaces) {
    const placeIds = new Set();

    try {
        // Remover o prefixo de proteção XSSI: )]}'
        const jsonStr = body.replace(/^\s*\)\]\}'\s*/, '');
        const data = JSON.parse(jsonStr);

        // Os place IDs (ChIJ...) estão espalhados pelo JSON aninhado
        // Buscar recursivamente qualquer string que comece com ChIJ
        function findPlaceIds(obj, depth = 0) {
            if (depth > 30 || placeIds.size >= maxPlaces * 3) return;
            if (typeof obj === 'string') {
                // Aceitar tanto string exata quanto substring com ChIJ
                const matches = obj.match(/ChIJ[\w-]{10,}/g);
                if (matches) matches.forEach(m => placeIds.add(m));
            } else if (Array.isArray(obj)) {
                for (const item of obj) findPlaceIds(item, depth + 1);
            } else if (obj && typeof obj === 'object') {
                for (const val of Object.values(obj)) findPlaceIds(val, depth + 1);
            }
        }

        findPlaceIds(data);

    } catch (e) {
        // Fallback: regex no texto cru
        const regex = /["']?(ChIJ[\w-]{10,})["']?/g;
        let match;
        while ((match = regex.exec(body)) !== null && placeIds.size < maxPlaces * 3) {
            placeIds.add(match[1]);
        }
    }

    return [...placeIds].slice(0, maxPlaces);
}

// Extrai links de lugares da resposta de busca
function extractPlaceLinksFromHtml(html, maxPlaces) {
    const links = new Set();
    let match;

    // Método 1: /maps/place/ absolutos (HTML clássico)
    const hrefRegex = /href="(https:\/\/www\.google\.com\/maps\/place\/[^"]+)"/g;
    while ((match = hrefRegex.exec(html)) !== null && links.size < maxPlaces * 3) {
        links.add(match[1].replace(/&amp;/g, '&'));
    }

    // Método 2: /maps/place/ relativos
    const relRegex = /href="(\/maps\/place\/[^"]+)"/g;
    while ((match = relRegex.exec(html)) !== null && links.size < maxPlaces * 3) {
        links.add('https://www.google.com' + match[1].replace(/&amp;/g, '&'));
    }

    // Método 3: parsear JSON do Google (resposta )]}'...)
    if (links.size === 0) {
        const placeIds = extractPlaceIdsFromSearchResponse(html, maxPlaces);
        console.log(`   Place IDs encontrados no JSON: ${placeIds.length}`);
        for (const pid of placeIds) {
            links.add(buildPlaceUrl(pid));
        }
    }

    return [...links].slice(0, maxPlaces);
}

// Extrai place_id do HTML cru (sem browser)
function extractPlaceIdFromHtml(html) {
    // Método 1: APP_INITIALIZATION_STATE contém o ChIJ...
    const appStateMatch = html.match(/"(ChIJ[\w-]{10,})"/g);
    if (appStateMatch && appStateMatch.length > 0) {
        return appStateMatch[0].replace(/"/g, '');
    }
    // Método 2: na URL canônica
    const canonicalMatch = html.match(/canonical.*?ChIJ[\w-]+/);
    if (canonicalMatch) {
        const idMatch = canonicalMatch[0].match(/ChIJ[\w-]+/);
        if (idMatch) return idMatch[0];
    }
    return null;
}

// Parser principal: extrai todos os dados de uma página de lugar via HTML cru
function parsePlaceFromHtml(html, url) {
    const data = {};

    try {
        // ── place_id ──────────────────────────────────────────────────────────
        data.place_id = extractPlaceIdFromHtml(html);

        // ── google_maps_url ───────────────────────────────────────────────────
        data.google_maps_url = url;

        // ── CID (0x...:0x...) ─────────────────────────────────────────────────
        const cidMatch = url.match(/!1s(0x[0-9a-fA-F]+:0x[0-9a-fA-F]+)/);
        data.cid = cidMatch ? cidMatch[1] : null;

        // ── knowledge_graph_id ────────────────────────────────────────────────
        const kgmidMatch = url.match(/!16s%2Fg%2F([a-zA-Z0-9_-]+)/);
        data.knowledge_graph_id = kgmidMatch ? `/g/${kgmidMatch[1]}` : null;

        // ── Coordenadas ───────────────────────────────────────────────────────
        const coordMatch = url.match(/@(-?\d+\.\d+),(-?\d+\.\d+),/);
        data.latitude = coordMatch ? parseFloat(coordMatch[1]) : null;
        data.longitude = coordMatch ? parseFloat(coordMatch[2]) : null;

        // ── Nome ──────────────────────────────────────────────────────────────
        // Google embute o nome no title da página: "Nome do Lugar - Google Maps"
        const titleMatch = html.match(/<title>([^<]+)<\/title>/);
        if (titleMatch) {
            data.name = titleMatch[1].replace(/ - Google Maps$/, '').trim();
        } else {
            data.name = null;
        }

        // ── Rating ────────────────────────────────────────────────────────────
        // Padrão no HTML: "4,8" ou "4.8" próximo de estrelas
        const ratingMatch = html.match(/"([\d],[0-9])\s*estrela/i) ||
                            html.match(/"([\d]\.[0-9])\s*star/i) ||
                            html.match(/\\"([0-9],[0-9])\\",\s*\d+\s*(?:avalia|review)/i);
        data.rating = ratingMatch ? cleanNumericValue(ratingMatch[1]) : null;

        // ── Reviews count ─────────────────────────────────────────────────────
        const reviewsMatch = html.match(/([\d.,]+)\s*(?:avalia[çc][oõ]es|reviews?)/i);
        if (reviewsMatch) {
            const raw = reviewsMatch[1].replace(/\./g, '').replace(',', '');
            data.reviews_count = parseInt(raw, 10) || null;
        } else {
            data.reviews_count = null;
        }

        // ── Endereço ──────────────────────────────────────────────────────────
        // Padrão: aparece em meta description ou structured data
        const addressMatch = html.match(/"address"\s*:\s*\{[^}]*"streetAddress"\s*:\s*"([^"]+)"/);
        if (addressMatch) {
            data.full_address = addressMatch[1];
        } else {
            // Fallback: buscar no JSON-LD
            const jsonLdMatch = html.match(/<script type="application\/ld\+json">([^<]+)<\/script>/g);
            if (jsonLdMatch) {
                for (const script of jsonLdMatch) {
                    try {
                        const json = JSON.parse(script.replace(/<script[^>]*>/, '').replace('</script>', ''));
                        if (json.address) {
                            const a = json.address;
                            data.full_address = [a.streetAddress, a.addressLocality, a.addressRegion, a.postalCode, a.addressCountry]
                                .filter(Boolean).join(', ');
                            break;
                        }
                    } catch (e) {}
                }
            }
            if (!data.full_address) data.full_address = null;
        }

        // ── Telefone ──────────────────────────────────────────────────────────
        const phoneMatch = html.match(/"telephone"\s*:\s*"([^"]+)"/) ||
                           html.match(/tel:([+\d\s()-]+)"/);
        data.phone = phoneMatch ? phoneMatch[1].trim() : null;

        // ── WhatsApp ──────────────────────────────────────────────────────────
        // Google Maps exibe links wa.me/ quando o lugar cadastra WhatsApp
        const waMatch = html.match(/https?:\/\/(?:api\.whatsapp\.com\/send[^"'\\]*phone=|wa\.me\/)(\d+)/i);
        if (waMatch) {
            data.whatsapp = '+' + waMatch[1];
        } else {
            // Fallback: buscar no JSON embebido (wa.me escappado como \u...)
            const waEscaped = html.match(/wa\\.me\\\/(\d+)/);
            data.whatsapp = waEscaped ? '+' + waEscaped[1] : null;
        }

        // ── Website ───────────────────────────────────────────────────────────
        const websiteMatch = html.match(/"url"\s*:\s*"(https?:\/\/(?!(?:www\.google|maps\.google|goo\.gl))[^"]+)"/);
        data.website = websiteMatch ? websiteMatch[1] : null;

        // ── Categorias ────────────────────────────────────────────────────────
        // Aparece em JSON-LD como "@type" ou em meta keywords
        const categoryMatch = html.match(/"@type"\s*:\s*"([^"]+)"/g);
        data.categories = categoryMatch
            ? [...new Set(categoryMatch.map(m => m.match(/"([^"]+)"$/)[1]).filter(c => c !== 'LocalBusiness' && c !== 'Place'))]
            : [];
        data.category_primary = data.categories.length > 0 ? data.categories[0] : null;

        // ── Business Status ───────────────────────────────────────────────────
        if (/permanentemente fechado|permanently closed/i.test(html)) {
            data.business_status = 'CLOSED_PERMANENTLY';
        } else if (/temporariamente fechado|temporarily closed/i.test(html)) {
            data.business_status = 'CLOSED_TEMPORARILY';
        } else {
            data.business_status = 'OPERATIONAL';
        }

        // ── Price Level ───────────────────────────────────────────────────────
        const priceMatch = html.match(/priceRange["']?\s*:\s*["'](\$+)["']/i);
        data.price_level = priceMatch ? priceMatch[1] : null;

        // ── Parsear endereço ──────────────────────────────────────────────────
        if (data.full_address) {
            const addressParts = parseAddress(data.full_address);
            Object.assign(data, addressParts);
        }

    } catch (e) {
        console.log(`⚠️  Erro ao parsear HTML: ${e.message}`);
    }

    return data;
}

// Executa N promises em paralelo com limite de concorrência
async function runWithConcurrency(tasks, concurrency) {
    const results = [];
    let index = 0;

    async function worker() {
        while (index < tasks.length) {
            const i = index++;
            try {
                results[i] = await tasks[i]();
            } catch (e) {
                results[i] = null;
            }
        }
    }

    const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, worker);
    await Promise.all(workers);
    return results;
}

// ─── Busca com Playwright (lista de lugares) ─────────────────────────────────

async function getPlaceLinksWithBrowser(searchTerm, location, language, maxPlaces) {
    const browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });

    try {
        const context = await browser.newContext({
            locale: language,
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        });
        const page = await context.newPage();

        const searchQuery = encodeURIComponent(`${searchTerm} ${location}`);
        const searchUrl = `https://www.google.com/maps/search/${searchQuery}?hl=${language}`;

        await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForSelector('div[role="feed"] a[href*="/maps/place/"]', { timeout: 15000 });

        // Scroll para carregar mais resultados
        const feed = 'div[role="feed"]';
        let prev = 0;
        for (let i = 0; i < 10; i++) {
            const count = await page.evaluate(sel => document.querySelectorAll(`${sel} a[href*="/maps/place/"]`).length, feed);
            if (count >= maxPlaces) break;
            await page.evaluate(sel => { const f = document.querySelector(sel); if (f) f.scrollTo(0, f.scrollHeight); }, feed);
            await page.waitForTimeout(1500);
            const newH = await page.evaluate(sel => { const f = document.querySelector(sel); return f ? f.scrollHeight : 0; }, feed);
            if (newH === prev) break;
            prev = newH;
        }

        // Coletar links únicos
        const links = await page.evaluate((max) => {
            const seen = new Set();
            const results = [];
            for (const el of document.querySelectorAll('a[href*="/maps/place/"]')) {
                if (el.href && !seen.has(el.href)) {
                    seen.add(el.href);
                    results.push(el.href);
                    if (results.length >= max) break;
                }
            }
            return results;
        }, maxPlaces);

        return links;

    } finally {
        await browser.close();
    }
}

// ─── Main ────────────────────────────────────────────────────────────────────

try {
    const input = await Actor.getInput();

    if (!input?.searchTerms?.length) throw new Error('searchTerms é obrigatório');
    if (!input.location) throw new Error('location é obrigatório');

    const {
        searchTerms,
        location,
        maxCrawledPlacesPerSearch = 20,
        language = 'pt-BR',
        onlyWithWebsite = false,
        concurrency = 10,
        userData = {}
    } = input;

    console.log(`\n🚀 Iniciando scraping (modo híbrido: browser p/ busca + fetch paralelo p/ detalhes)`);
    console.log(`   📍 Localização: ${location}`);
    console.log(`   🔍 Termos de busca: ${searchTerms.length} termo(s)`);
    console.log(`   📊 Máximo por busca: ${maxCrawledPlacesPerSearch} lugares`);
    console.log(`   ⚡ Concorrência: ${concurrency} requests paralelos`);
    console.log(`   🌐 Idioma: ${language}\n`);

    const allResults = [];
    const seenPlaceIds = new Set();

    for (const searchTerm of searchTerms) {
        console.log(`\n=== Buscando: "${searchTerm}" em ${location} ===`);

        // ETAPA 1: Usar browser para obter a lista de links (requer JS)
        let placeLinks = [];
        try {
            console.log(`🌐 Abrindo browser para coletar lista de lugares...`);
            placeLinks = await getPlaceLinksWithBrowser(searchTerm, location, language, maxCrawledPlacesPerSearch);
            console.log(`   ✅ ${placeLinks.length} links coletados`);
        } catch (e) {
            console.log(`❌ Erro ao buscar lista: ${e.message}`);
            continue;
        }

        if (placeLinks.length === 0) {
            console.log(`⚠️  Nenhum lugar encontrado para "${searchTerm}"`);
            continue;
        }

        // ETAPA 2: Fetch paralelo para detalhes de cada lugar (sem browser)
        console.log(`⚡ Extraindo detalhes de ${placeLinks.length} lugares em paralelo (concorrência: ${concurrency})...`);

        const tasks = placeLinks.map((link, i) => async () => {
            try {
                const html = await fetchPage(link, language);
                const placeData = parsePlaceFromHtml(html, link);

                if (!placeData.name) {
                    console.log(`⚠️  [${i+1}] Lugar sem nome, ignorando`);
                    return null;
                }

                const dedupeKey = placeData.place_id || placeData.cid || link;
                if (seenPlaceIds.has(dedupeKey)) {
                    console.log(`⏭️  [${i+1}] ${placeData.name} ignorado (duplicado)`);
                    return null;
                }
                seenPlaceIds.add(dedupeKey);

                if (onlyWithWebsite && !placeData.website) {
                    console.log(`⏭️  [${i+1}] ${placeData.name} ignorado (sem website)`);
                    return null;
                }

                const result = {
                    search_term: searchTerm,
                    location,
                    ...placeData,
                    ...userData,
                    scraped_at: new Date().toISOString()
                };

                await Actor.pushData(result);
                console.log(`✓ [${i+1}] ${placeData.name} (${placeData.rating || 'N/A'} ⭐ | ${placeData.reviews_count || 0} reviews)`);
                return result;

            } catch (e) {
                console.log(`❌ [${i+1}] Erro: ${e.message}`);
                return null;
            }
        });

        const results = await runWithConcurrency(tasks, concurrency);
        const valid = results.filter(Boolean);
        allResults.push(...valid);

        console.log(`   ✅ ${valid.length} lugares salvos para "${searchTerm}"`);
    }

    console.log(`\n=== Scraping concluído ===`);
    console.log(`Total de lugares extraídos: ${allResults.length}`);

} catch (error) {
    console.error('Erro fatal:', error);
    throw error;
}

await Actor.exit();

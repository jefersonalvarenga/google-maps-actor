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
        // Formato 1: @lat,lng,  (URL de busca)
        // Formato 2: !3d<lat>!4d<lng>  (URL de lugar individual, ex: data=...!3d-16.01!4d-48.05)
        const coordMatch = url.match(/@(-?\d+\.\d+),(-?\d+\.\d+),/) ||
                           url.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
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

        // ── Services ──────────────────────────────────────────────────────────
        // O Google Maps lista serviços/comodidades no HTML (ex: "Aceita cartão")
        // Extrair itens de listas de serviços quando disponível
        const serviceMatches = html.match(/"serviceType"\s*:\s*"([^"]+)"/g) ||
                               html.match(/aria-label="([^"]+)"\s+[^>]*checked/g);
        data.services = serviceMatches
            ? [...new Set(serviceMatches.map(m => m.match(/"([^"]+)"(?:\s*$|\s+[^>]*checked)/)?.[1]).filter(Boolean))]
            : [];

        // ── Rating Distribution ───────────────────────────────────────────────
        // Distribuição de estrelas (5, 4, 3, 2, 1) — raramente disponível no HTML estático
        data.rating_distribution = null;

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

// ─── Extrai dados do painel lateral após clicar em um lugar ──────────────────

async function extractPlaceDataFromPanel(page) {
    // Aguarda o nome aparecer (indica que o painel principal carregou)
    await page.waitForSelector('h1.DUwDvf, h1.fontHeadlineLarge, h1', { timeout: 30000 });
    // Aguarda phone ou address aparecerem (dados XHR — chegam logo após o h1)
    await page.waitForSelector(
        'button[data-item-id^="phone:tel:"], a[href^="tel:"], button[data-item-id="address"]',
        { timeout: 8000 }
    ).catch(() => {}); // silencia — nem todos os lugares têm phone/address

    return page.evaluate(() => {
        const getText = sel => document.querySelector(sel)?.textContent?.trim() || null;
        const getAttr = (sel, attr) => document.querySelector(sel)?.getAttribute(attr) || null;

        // ── Nome ──────────────────────────────────────────────────────────────
        const name = getText('h1');

        // ── Rating ────────────────────────────────────────────────────────────
        const ratingEl = document.querySelector('div[role="img"][aria-label*="estrela"], div[role="img"][aria-label*="star"]');
        const ratingRaw = ratingEl?.getAttribute('aria-label')?.match(/[\d,.]+/)?.[0];
        const rating = ratingRaw ? parseFloat(ratingRaw.replace(',', '.')) : null;

        // ── Reviews ───────────────────────────────────────────────────────────
        const reviewsEl = [...document.querySelectorAll('button span')].find(el => /\d.*avalia|review/i.test(el.textContent));
        const reviewsRaw = reviewsEl?.textContent?.match(/([\d.,]+)/)?.[1];
        const reviews_count = reviewsRaw ? parseInt(reviewsRaw.replace(/[.,]/g, ''), 10) : null;

        // ── Telefone ──────────────────────────────────────────────────────────
        const phoneEl = document.querySelector('button[data-item-id^="phone:tel:"], a[href^="tel:"]');
        const phone = phoneEl?.getAttribute('data-item-id')?.replace('phone:tel:', '') ||
                      phoneEl?.getAttribute('href')?.replace('tel:', '') ||
                      null;

        // ── Website ───────────────────────────────────────────────────────────
        const websiteEl = document.querySelector('a[data-item-id="authority"], a[href*="//"][aria-label*="site"], a[href*="//"][aria-label*="website"]');
        const website = websiteEl?.href || null;

        // ── WhatsApp ──────────────────────────────────────────────────────────
        const waEl = document.querySelector('a[href*="wa.me"], a[href*="api.whatsapp.com"]');
        const waHref = waEl?.href || '';
        const waMatch = waHref.match(/(?:wa\.me\/|phone=)(\d+)/);
        const whatsapp = waMatch ? '+' + waMatch[1] : null;

        // ── Endereço ──────────────────────────────────────────────────────────
        const addrEl = document.querySelector('button[data-item-id="address"]');
        const full_address = addrEl?.textContent?.trim() || null;

        // ── Categoria ─────────────────────────────────────────────────────────
        const categoryEl = document.querySelector('button[jsaction*="category"], span.DkEaL');
        const category_primary = categoryEl?.textContent?.trim() || null;

        // ── Business Status ───────────────────────────────────────────────────
        const bodyText = document.body.innerText;
        let business_status = 'OPERATIONAL';
        if (/permanentemente fechado|permanently closed/i.test(bodyText)) business_status = 'CLOSED_PERMANENTLY';
        else if (/temporariamente fechado|temporarily closed/i.test(bodyText)) business_status = 'CLOSED_TEMPORARILY';

        // ── Price Level ───────────────────────────────────────────────────────
        const priceEl = [...document.querySelectorAll('span')].find(el => /^[$€£]{1,4}$/.test(el.textContent.trim()));
        const price_level = priceEl?.textContent?.trim() || null;

        // ── URL atual (contém coordenadas, place_id, etc.) ────────────────────
        const currentUrl = window.location.href;

        return { name, rating, reviews_count, phone, website, whatsapp, full_address,
                 category_primary, business_status, price_level, currentUrl };
    });
}

// ─── Extrai dados de um lugar (uma página/tab por vez) ───────────────────────

async function extractPlace(browser, link, language, label) {
    const context = await browser.newContext({
        locale: language,
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });
    const page = await context.newPage();
    try {
        await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 60000 });
        const panelData = await extractPlaceDataFromPanel(page);
        const finalUrl = panelData.currentUrl || link;

        const cidMatch    = finalUrl.match(/!1s(0x[0-9a-fA-F]+:0x[0-9a-fA-F]+)/);
        const kgmidMatch  = finalUrl.match(/!16s%2Fg%2F([a-zA-Z0-9_-]+)/);
        const coordMatch  = finalUrl.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/) ||
                            finalUrl.match(/@(-?\d+\.\d+),(-?\d+\.\d+),/);
        const placeId     = extractPlaceIdFromHtml(await page.content());

        const place = {
            ...panelData,
            google_maps_url: finalUrl,
            place_id: placeId,
            cid: cidMatch  ? cidMatch[1]            : null,
            knowledge_graph_id: kgmidMatch ? `/g/${kgmidMatch[1]}` : null,
            latitude:  coordMatch ? parseFloat(coordMatch[1]) : null,
            longitude: coordMatch ? parseFloat(coordMatch[2]) : null,
            categories: panelData.category_primary ? [panelData.category_primary] : [],
            services: [],
            rating_distribution: null,
        };
        delete place.currentUrl;

        if (panelData.full_address) {
            Object.assign(place, parseAddress(panelData.full_address));
        }

        console.log(`   ✓ ${label} ${place.name} | ⭐ ${place.rating ?? '-'} (${place.reviews_count ?? 0} reviews) | ☎ ${place.phone || '-'} | 🌐 ${place.website || '-'}`);
        return place;
    } finally {
        await context.close();
    }
}

// ─── Busca e extrai dados com Playwright (paralelo) ──────────────────────────

async function scrapeWithBrowser(searchTerm, location, language, maxPlaces, concurrency, onPlaceReady) {
    const browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });

    const places = [];

    try {
        // ETAPA 1: Coletar lista de links via uma única aba de busca
        const searchContext = await browser.newContext({
            locale: language,
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        });
        const searchPage = await searchContext.newPage();

        const searchQuery = encodeURIComponent(`${searchTerm} ${location}`);
        const searchUrl = `https://www.google.com/maps/search/${searchQuery}?hl=${language}`;

        await searchPage.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await searchPage.waitForSelector('div[role="feed"] a[href*="/maps/place/"]', { timeout: 15000 });

        const feed = 'div[role="feed"]';
        let prev = 0;
        for (let i = 0; i < 10; i++) {
            const count = await searchPage.evaluate(
                sel => document.querySelectorAll(`${sel} a[href*="/maps/place/"]`).length, feed
            );
            if (count >= maxPlaces) break;
            await searchPage.evaluate(
                sel => { const f = document.querySelector(sel); if (f) f.scrollTo(0, f.scrollHeight); }, feed
            );
            await searchPage.waitForTimeout(1200);
            const newH = await searchPage.evaluate(
                sel => { const f = document.querySelector(sel); return f ? f.scrollHeight : 0; }, feed
            );
            if (newH === prev) break;
            prev = newH;
        }

        const links = await searchPage.evaluate((max) => {
            const seen = new Set();
            const result = [];
            for (const el of document.querySelectorAll('a[href*="/maps/place/"]')) {
                if (el.href && !seen.has(el.href)) {
                    seen.add(el.href);
                    result.push(el.href);
                    if (result.length >= max) break;
                }
            }
            return result;
        }, maxPlaces);

        await searchContext.close();
        console.log(`   📋 ${links.length} links coletados — extraindo em paralelo (${concurrency} tabs)...`);

        // ETAPA 2: Abrir cada lugar sequencialmente (1 tab por vez — mais estável no container)
        const total = links.length;
        for (let i = 0; i < total; i++) {
            const label = `[${i+1}/${total}]`;
            try {
                const place = await extractPlace(browser, links[i], language, label);
                places.push(place);
                if (onPlaceReady) await onPlaceReady(place);
            } catch (e) {
                console.log(`   ⚠️  ${label} Erro: ${e.message.split('\n')[0]}`);
            }
        }

    } finally {
        await browser.close();
    }

    return places;
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
        concurrency = 3,
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

        let saved = 0;

        const onPlaceReady = async (placeData) => {
            if (!placeData.name) return;

            const dedupeKey = placeData.place_id || placeData.cid || placeData.google_maps_url;
            if (seenPlaceIds.has(dedupeKey)) {
                console.log(`⏭️  ${placeData.name} ignorado (duplicado)`);
                return;
            }
            seenPlaceIds.add(dedupeKey);

            if (onlyWithWebsite && !placeData.website) {
                console.log(`⏭️  ${placeData.name} ignorado (sem website)`);
                return;
            }

            const result = {
                search_term: searchTerm,
                location,
                ...placeData,
                ...userData,
                scraped_at: new Date().toISOString()
            };

            await Actor.pushData(result);
            allResults.push(result);
            saved++;
        };

        try {
            console.log(`🌐 Abrindo browser para busca e extração de dados...`);
            await scrapeWithBrowser(searchTerm, location, language, maxCrawledPlacesPerSearch, concurrency, onPlaceReady);
        } catch (e) {
            console.log(`❌ Erro ao buscar "${searchTerm}": ${e.message}`);
            continue;
        }

        console.log(`   ✅ ${saved} lugares salvos para "${searchTerm}"`);
    }

    console.log(`\n=== Scraping concluído ===`);
    console.log(`Total de lugares extraídos: ${allResults.length}`);

} catch (error) {
    console.error('Erro fatal:', error);
    throw error;
}

await Actor.exit();

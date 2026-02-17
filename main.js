import { Actor } from 'apify';

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

// Extrai place IDs do HTML da página de busca (/search?tbm=map)
// O Google retorna query_place_id=ChIJ... nos links dos resultados
function extractPlaceIdsFromSearchHtml(html) {
    const placeIds = new Set();

    // Formato: query_place_id=ChIJ...
    const regex = /query_place_id=(ChIJ[\w-]+)/g;
    let match;
    while ((match = regex.exec(html)) !== null) {
        placeIds.add(match[1]);
    }

    // Formato alternativo: !1sChIJ... nos dados embutidos
    const altRegex = /!1s(ChIJ[\w-]{10,})/g;
    while ((match = altRegex.exec(html)) !== null) {
        placeIds.add(match[1]);
    }

    return [...placeIds];
}

// Monta a URL canônica do Google Maps para um place_id
function buildPlaceUrl(placeId) {
    return `https://www.google.com/maps/search/?api=1&query_place_id=${placeId}`;
}

// Extrai links de lugares da página de busca
function extractPlaceLinksFromHtml(html, maxPlaces) {
    const links = new Set();
    let match;

    // Método 1: /maps/place/ absolutos
    const hrefRegex = /href="(https:\/\/www\.google\.com\/maps\/place\/[^"]+)"/g;
    while ((match = hrefRegex.exec(html)) !== null && links.size < maxPlaces * 3) {
        links.add(match[1].replace(/&amp;/g, '&'));
    }

    // Método 2: /maps/place/ relativos
    const relRegex = /href="(\/maps\/place\/[^"]+)"/g;
    while ((match = relRegex.exec(html)) !== null && links.size < maxPlaces * 3) {
        links.add('https://www.google.com' + match[1].replace(/&amp;/g, '&'));
    }

    // Método 3: place IDs extraídos → montar URL via /search?api=1&query_place_id=
    if (links.size === 0) {
        const placeIds = extractPlaceIdsFromSearchHtml(html);
        for (const pid of placeIds.slice(0, maxPlaces * 3)) {
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

    console.log(`\n🚀 Iniciando scraping (modo HTTP — sem browser)`);
    console.log(`   📍 Localização: ${location}`);
    console.log(`   🔍 Termos de busca: ${searchTerms.length} termo(s)`);
    console.log(`   📊 Máximo por busca: ${maxCrawledPlacesPerSearch} lugares`);
    console.log(`   ⚡ Concorrência: ${concurrency} requests paralelos`);
    console.log(`   🌐 Idioma: ${language}\n`);

    const allResults = [];
    const seenPlaceIds = new Set();

    for (const searchTerm of searchTerms) {
        console.log(`\n=== Buscando: "${searchTerm}" em ${location} ===`);

        const searchQuery = encodeURIComponent(`${searchTerm} ${location}`);
        // Usar /search?tbm=map que retorna HTML mesmo sem JS
        const searchUrl = `https://www.google.com/search?tbm=map&hl=${language}&q=${searchQuery}`;

        let placeLinks = [];
        try {
            console.log(`📡 Buscando lista de lugares...`);
            const searchHtml = await fetchPage(searchUrl, language);
            // DEBUG: logar primeiros 2000 chars do HTML para diagnóstico
            console.log(`DEBUG HTML (primeiros 2000 chars):\n${searchHtml.substring(0, 2000)}`);
            placeLinks = extractPlaceLinksFromHtml(searchHtml, maxCrawledPlacesPerSearch);
            console.log(`   Encontrados ${placeLinks.length} links de lugares`);
        } catch (e) {
            console.log(`❌ Erro ao buscar lista: ${e.message}`);
            continue;
        }

        if (placeLinks.length === 0) {
            console.log(`⚠️  Nenhum lugar encontrado para "${searchTerm}"`);
            continue;
        }

        // Criar tasks para executar em paralelo
        const tasks = placeLinks.map((link, i) => async () => {
            try {
                console.log(`[${i + 1}/${placeLinks.length}] Extraindo: ${link.substring(0, 80)}...`);
                const html = await fetchPage(link, language);
                const placeData = parsePlaceFromHtml(html, link);

                if (!placeData.name) {
                    console.log(`⚠️  Lugar sem nome, ignorando`);
                    return null;
                }

                const dedupeKey = placeData.place_id || placeData.cid || link;
                if (seenPlaceIds.has(dedupeKey)) {
                    console.log(`⏭️  ${placeData.name} ignorado (duplicado)`);
                    return null;
                }
                seenPlaceIds.add(dedupeKey);

                if (onlyWithWebsite && !placeData.website) {
                    console.log(`⏭️  ${placeData.name} ignorado (sem website)`);
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
                console.log(`✓ ${placeData.name} (${placeData.rating || 'N/A'} ⭐ | ${placeData.reviews_count || 0} reviews)`);
                return result;

            } catch (e) {
                console.log(`❌ Erro ao extrair lugar: ${e.message}`);
                return null;
            }
        });

        // Executar em paralelo com limite de concorrência
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

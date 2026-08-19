/**
 * fetch_news.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Her 30 dakikada GitHub Actions tarafından çalıştırılır.
 * Kaynak: Google News RSS (ücretsiz, Türkçe). Yedek YOK — bkz. aşağıdaki not.
 *
 * Çıktı: data/news.json
 * ─────────────────────────────────────────────────────────────────────────────
 */

const fs    = require('fs');
const https = require('https');
const path  = require('path');

const OUTPUT_FILE  = path.join(__dirname, '..', 'data', 'news.json');

// ── Google News RSS sorguları ─────────────────────────────────────────────────
// Her sorgu kendi kategorisini taşır. Eskiden yalnızca sorgu metni tutuluyor,
// kategori hiç atanmıyordu; sonuçta tüm haberler 'general' olarak yazılıyor ve
// kategori alanı işlevsiz kalıyordu.
const RSS_QUERIES = [
    { q: 'altın fiyat',            category: 'gold'    },
    { q: 'dolar kur',              category: 'forex'   },
    { q: 'ekonomi faiz enflasyon', category: 'economy' },
    { q: 'kripto bitcoin',         category: 'crypto'  },
];

// ── Yardımcı: HTTP GET ────────────────────────────────────────────────────────
function fetchRaw(url) {
    return new Promise(resolve => {
        const req = https.get(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AltinZincir/1.0)' }
        }, res => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return fetchRaw(res.headers.location).then(resolve);
            }
            let raw = '';
            res.on('data', c => raw += c);
            res.on('end', () => resolve({ status: res.statusCode, body: raw }));
        });
        req.on('error', () => resolve(null));
        req.setTimeout(12000, () => { req.destroy(); resolve(null); });
    });
}

// ── RSS XML parser (hafif, bağımlılıksız) ────────────────────────────────────
function parseRSS(xml) {
    const items = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let match;
    while ((match = itemRegex.exec(xml)) !== null) {
        const block = match[1];
        const get = (tag) => {
            const m = block.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>|<${tag}[^>]*>([^<]*)<\\/${tag}>`));
            return m ? (m[1] || m[2] || '').trim() : '';
        };
        const title   = get('title');
        const link    = get('link');
        const pubDate = get('pubDate');
        const source  = block.match(/<source[^>]*>([^<]*)<\/source>/)?.[1]?.trim() || 'Google News';
        if (title && link) {
            items.push({
                id:       Buffer.from(link).toString('base64').slice(0, 16),
                title,
                source,
                url:      link,
                publishedAt: pubDate ? new Date(pubDate).toISOString() : new Date().toISOString(),
                category: 'general'
            });
        }
    }
    return items;
}

// ── Birincil: Google News RSS ─────────────────────────────────────────────────
async function fetchGoogleNews() {
    const allItems = [];
    const seen = new Set();

    for (const { q, category } of RSS_QUERIES) {
        const encoded = encodeURIComponent(q);
        const url = `https://news.google.com/rss/search?q=${encoded}&hl=tr&gl=TR&ceid=TR:tr`;
        console.log(`  📰 RSS: "${q}" (${category})`);
        const res = await fetchRaw(url);
        if (!res || res.status !== 200) { console.warn(`    ⚠️  Boş yanıt`); continue; }

        const items = parseRSS(res.body);
        for (const item of items) {
            if (!seen.has(item.url)) {
                seen.add(item.url);
                // Haber hangi sorgudan geldiyse o kategoriyi alır
                allItems.push({ ...item, category });
            }
        }
        console.log(`    ✅ ${items.length} haber`);
    }
    return allItems;
}

// NewsAPI yedegi KALDIRILDI (2026-08).
// Neden: NewsAPI'nin ucretsiz katmani kullanim sartlarinda ACIKCA yalnizca
// gelistirme/test icindir; uretimde kullanmak lisans ihlali. Ustelik cektigimiz
// haberler data/news.json olarak herkese acik yayinlaniyor, bu da NewsAPI'nin
// yeniden dagitim yasagina giriyor. Google News RSS tek kaynak olarak yeterli
// (olculdu: 4 sorgudan 391 haber, kota sonrasi 50 yayinlaniyor).

// ── Ana fonksiyon ─────────────────────────────────────────────────────────────
async function run() {
    console.log('📰 Haberler çekiliyor...');

    // Birincil: Google News RSS
    let items = await fetchGoogleNews();
    console.log(`✅ Google News: ${items.length} haber`);

    // Google News tek kaynak. Yedek yok: NewsAPI'nin ucretsiz katmani
    // uretimde kullanilamiyor (bkz. yukaridaki not). Haber gelmezse onceki
    // news.json korunur.
    if (items.length === 0) {
        console.error('❌ Google News RSS hiç haber döndürmedi — mevcut dosya korunuyor');
        process.exit(1);
    }

    // Tarihe göre sırala (en yeni önce)
    items.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

    // Kategori başına kota ile seç. Düz "ilk 50" almak, o an yoğun yayın yapan
    // kategorinin (ör. kripto) listeyi tamamen doldurmasına yol açıyor ve
    // döviz/ekonomi haberleri hiç görünmüyordu.
    const TOTAL      = 50;
    const categories = [...new Set(items.map(i => i.category))];
    const perCat     = Math.max(1, Math.floor(TOTAL / Math.max(1, categories.length)));
    const picked     = [];
    const pickedUrls = new Set();

    for (const cat of categories) {
        for (const item of items.filter(i => i.category === cat).slice(0, perCat)) {
            picked.push(item);
            pickedUrls.add(item.url);
        }
    }
    // Kota sonrası boşluk kalırsa en yeni haberlerle tamamla
    for (const item of items) {
        if (picked.length >= TOTAL) break;
        if (!pickedUrls.has(item.url)) { picked.push(item); pickedUrls.add(item.url); }
    }

    picked.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
    items = picked.slice(0, TOTAL);

    const output = {
        _meta: {
            updated_at: new Date().toISOString(),
            count: items.length,
            source: 'Google News RSS'
        },
        items
    };

    fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2), 'utf8');
    console.log(`\n✅ data/news.json kaydedildi (${items.length} haber)`);
}

run().catch(err => { console.error('❌ Hata:', err); process.exit(1); });

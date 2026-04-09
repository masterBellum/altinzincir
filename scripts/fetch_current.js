/**
 * fetch_current.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Her 5 dakikada GitHub Actions tarafından çalıştırılır.
 * Truncgil (altın + döviz) ve Binance (kripto) kaynaklarından anlık fiyatları çeker,
 * data/current.json dosyasına yazar.
 *
 * App artık doğrudan API'lere istek atmaz — sadece bu dosyayı okur.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const fs    = require('fs');
const https = require('https');
const path  = require('path');

const OUTPUT_FILE = path.join(__dirname, '..', 'data', 'current.json');

// ── Kaynak URL'leri ───────────────────────────────────────────────────────────
const TRUNCGIL_URL    = 'https://finans.truncgil.com/today.json';
const COINGECKO_URL   = 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,binancecoin,solana,ripple,dogecoin,avalanche-2,litecoin&vs_currencies=usd&include_24hr_change=true';
const GENPARA_EMTIA   = 'https://api.genelpara.com/json/?list=emtia&sembol=all';

// ── Yardımcı fonksiyonlar ─────────────────────────────────────────────────────
function fetchJson(url) {
    return new Promise(resolve => {
        const req = https.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
                'Accept': 'application/json,*/*'
            }
        }, res => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return fetchJson(res.headers.location).then(resolve);
            }
            let raw = '';
            res.on('data', c => raw += c);
            res.on('end', () => {
                try {
                    if (raw.trimStart().startsWith('<')) { resolve(null); return; }
                    resolve(JSON.parse(raw));
                } catch { resolve(null); }
            });
        });
        req.on('error', () => resolve(null));
        req.setTimeout(10000, () => { req.destroy(); resolve(null); });
    });
}

function parseTR(val) {
    if (val == null) return NaN;
    const s = String(val).replace(/[\s$€£¥TL]/gi, '').trim();
    if (!s || s === '-') return NaN;
    if (s.includes(',') && s.includes('.')) return parseFloat(s.replace(/\./g, '').replace(',', '.'));
    if (s.includes(',')) return parseFloat(s.replace(',', '.'));
    return parseFloat(s);
}

// ── Altın key → meta tablosu ──────────────────────────────────────────────────
const GOLD_MAP = {
    'gram-altin':      { name: 'Gram Altın',         code: 'GRAM',    type: 'gold' },
    'ons':             { name: 'Ons Altın',           code: 'ONS',     type: 'gold', isUSD: true },
    'ceyrek-altin':    { name: 'Çeyrek Altın',        code: 'CEYREK',  type: 'gold' },
    'yarim-altin':     { name: 'Yarım Altın',         code: 'YARIM',   type: 'gold' },
    'tam-altin':       { name: 'Tam Altın',           code: 'TAM',     type: 'gold' },
    'cumhuriyet-altini':{ name:'Cumhuriyet Altını',   code: 'CUMHUR',  type: 'gold' },
    'ata-altin':       { name: 'Ata Altın',           code: 'ATAALT',  type: 'gold' },
    'resat-altin':     { name: 'Reşat Altın',         code: 'RESAT',   type: 'gold' },
    'hamit-altin':     { name: 'Hamit Altın',         code: 'HAMIT',   type: 'gold' },
    'gram-has-altin':  { name: 'Gram Has Altın',      code: 'HAS',     type: 'gold' },
    '14-ayar-altin':   { name: '14 Ayar Altın',       code: '14AYAR',  type: 'gold' },
    '18-ayar-altin':   { name: '18 Ayar Altın',       code: '18AYAR',  type: 'gold' },
    '22-ayar-bilezik': { name: '22 Ayar Bilezik',     code: '22AYAR',  type: 'gold' },
    'gumus':           { name: 'Gümüş',               code: 'GUMUS',   type: 'commodity' },
    'gram-platin':     { name: 'Gram Platin',          code: 'PLATIN',  type: 'commodity' },
};

const CURRENCY_NAMES = {
    USD: 'ABD Doları', EUR: 'Euro', GBP: 'İngiliz Sterlini',
    JPY: 'Japon Yeni', CHF: 'İsviçre Frangı', CAD: 'Kanada Doları',
    AUD: 'Avustralya Doları', SAR: 'Suudi Riyali', RUB: 'Rus Rublesi',
    KWD: 'Kuveyt Dinarı', AZN: 'Azerbaycan Manatı', AED: 'BAE Dirhemi',
    QAR: 'Katar Riyali', ILS: 'İsrail Şekeli',
};

// İzlenecek kriptolar (CoinGecko id → varlık meta)
const CRYPTO_MAP = {
    'bitcoin':     { key: 'btc',  name: 'Bitcoin',   code: 'BTC',  type: 'crypto' },
    'ethereum':    { key: 'eth',  name: 'Ethereum',  code: 'ETH',  type: 'crypto' },
    'binancecoin': { key: 'bnb',  name: 'BNB',       code: 'BNB',  type: 'crypto' },
    'solana':      { key: 'sol',  name: 'Solana',    code: 'SOL',  type: 'crypto' },
    'ripple':      { key: 'xrp',  name: 'XRP',       code: 'XRP',  type: 'crypto' },
    'dogecoin':    { key: 'doge', name: 'Dogecoin',  code: 'DOGE', type: 'crypto' },
    'avalanche-2': { key: 'avax', name: 'Avalanche', code: 'AVAX', type: 'crypto' },
    'litecoin':    { key: 'ltc',  name: 'Litecoin',  code: 'LTC',  type: 'crypto' },
};

// ── Ana fonksiyon ─────────────────────────────────────────────────────────────
async function run() {
    // Mevcut dosyayı oku (yoksa boş başla)
    let current = {};
    try { current = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf8')); } catch {}

    // ── 1. Truncgil (Altın + Döviz) ──────────────────────────────────────────
    console.log('⬇️  Truncgil çekiliyor...');
    const tData = await fetchJson(TRUNCGIL_URL);
    let usdTry = current['USD']?.current || 38;

    if (tData) {
        // USD/TRY'yi ilk önce al (ons dönüşümü için lazım)
        if (tData['USD']) {
            const u = parseTR(tData['USD']['Satış'] || tData['USD']['Satis']);
            if (!isNaN(u) && u > 0) usdTry = u;
        }

        // Altın & Emtia
        Object.entries(GOLD_MAP).forEach(([tKey, meta]) => {
            const row = tData[tKey];
            if (!row) return;
            const satisKey = Object.keys(row).find(k => /sat/i.test(k));
            const alisKey  = Object.keys(row).find(k => /al/i.test(k) && !/sat/i.test(k));
            const degKey   = Object.keys(row).find(k => /değ|deg/i.test(k));
            let satis  = parseTR(satisKey ? row[satisKey] : null);
            let alis   = parseTR(alisKey  ? row[alisKey]  : null);
            const chg  = parseTR(String(degKey ? row[degKey] : 0).replace('%', ''));
            if (isNaN(satis) || satis <= 0) return;
            if (meta.isUSD) {
                satis = parseFloat((satis * usdTry).toFixed(2));
                if (!isNaN(alis) && alis > 0) alis = parseFloat((alis * usdTry).toFixed(2));
            }

            current[tKey] = {
                name: meta.name, code: meta.code, type: meta.type,
                current: satis,
                selling: satis,
                buying:  !isNaN(alis) && alis > 0 ? alis : parseFloat((satis * 0.995).toFixed(2)),
                change:  !isNaN(chg) ? chg : 0
            };
        });

        // Döviz
        Object.entries(tData).forEach(([sym, row]) => {
            if (!row || row['Tür'] !== 'Döviz') return;
            const satis  = parseTR(row['Satış'] || row['Satis']);
            const alis   = parseTR(row['Alış']  || row['Alis']);
            const chgStr = String(row['Değişim'] || '0').replace('%', '');
            const chg    = parseTR(chgStr);
            if (isNaN(satis) || satis <= 0) return;
            current[sym] = {
                name: CURRENCY_NAMES[sym] || sym, code: sym, type: 'currency',
                current: satis, selling: satis,
                buying:  !isNaN(alis) && alis > 0 ? alis : parseFloat((satis * 0.995).toFixed(2)),
                change:  !isNaN(chg) ? chg : 0
            };
        });
        console.log(`  ✅ Truncgil: altın + döviz işlendi`);
    } else {
        console.warn('  ⚠️ Truncgil verisi alınamadı, mevcut fiyatlar korunuyor');
    }

    // ── 2. GenelPara (Emtia) ─────────────────────────────────────────────────
    console.log('⬇️  GenelPara emtia çekiliyor...');
    const gpData = await fetchJson(GENPARA_EMTIA);
    if (gpData?.data) {
        const EMTIA_MAP = {
            XAGUSD: { name: 'Gümüş',        code: 'XAG' },
            XPTUSD: { name: 'Platin',        code: 'XPT' },
            XPDUSD: { name: 'Paladyum',      code: 'XPD' },
            XBRUSD: { name: 'Brent Ham Petrol', code: 'BRENT' },
            COIL:   { name: 'Ham Petrol (WTI)', code: 'WTI'  },
            COPPER: { name: 'Bakır',         code: 'COPPER' },
            NGAS:   { name: 'Doğal Gaz',     code: 'NGAS'  },
            WHEAT:  { name: 'Buğday',        code: 'WHEAT' },
            CORN:   { name: 'Mısır',         code: 'CORN'  },
            COFFEE: { name: 'Kahve',         code: 'COFFEE'},
            SUGAR:  { name: 'Şeker',         code: 'SUGAR' },
            COCOA:  { name: 'Kakao',         code: 'COCOA' },
            SOYBEAN:{ name: 'Soya Fasulyesi',code: 'SOYBEAN'},
            COTTON: { name: 'Pamuk',         code: 'COTTON'},
        };
        Object.entries(gpData.data).forEach(([sym, row]) => {
            const meta = EMTIA_MAP[sym];
            if (!meta) return;
            const satis = parseTR(row.satis);
            if (isNaN(satis) || satis <= 0) return;
            const satisTRY = parseFloat((satis * usdTry).toFixed(2));
            const oran = parseTR(String(row.oran || 0).replace('%', '').replace('+', ''));
            current[sym] = {
                name: meta.name, code: meta.code, type: 'commodity',
                current: satisTRY, selling: satisTRY,
                buying:  parseFloat((satisTRY * 0.998).toFixed(2)),
                change:  !isNaN(oran) ? oran : 0,
                priceUSD: satis
            };
        });
        console.log(`  ✅ GenelPara: ${Object.keys(gpData.data).length} emtia işlendi`);
    } else {
        console.warn('  ⚠️ GenelPara emtia verisi alınamadı');
    }

    // ── 3. CoinGecko (Kripto) ────────────────────────────────────────────────
    console.log('⬇️  CoinGecko kripto çekiliyor...');
    const cgData = await fetchJson(COINGECKO_URL);
    if (cgData && typeof cgData === 'object' && !Array.isArray(cgData)) {
        let cryptoCount = 0;
        Object.entries(cgData).forEach(([id, row]) => {
            const meta = CRYPTO_MAP[id];
            if (!meta) return;
            const priceUSD = row.usd;
            if (!priceUSD || isNaN(priceUSD) || priceUSD <= 0) return;
            const priceTRY = parseFloat((priceUSD * usdTry).toFixed(2));
            const chg      = parseFloat((row.usd_24h_change || 0).toFixed(2));
            current[meta.key] = {
                name: meta.name, code: meta.code, type: 'crypto',
                current: priceTRY, selling: priceTRY, buying: priceTRY,
                change: chg
            };
            cryptoCount++;
        });
        console.log(`  ✅ CoinGecko: ${cryptoCount} kripto işlendi`);
    } else {
        console.warn('  ⚠️ CoinGecko verisi alınamadı');
    }

    // ── Meta bilgisi ekle ve kaydet ───────────────────────────────────────────
    current['_meta'] = {
        updated_at: new Date().toISOString(),
        source: 'GitHub Actions / fetch_current.js'
    };

    fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(current, null, 2), 'utf8');
    console.log(`\n✅ data/current.json kaydedildi (${Object.keys(current).length - 1} varlık)`);
}

run().catch(err => {
    console.error('❌ Hata:', err);
    process.exit(1);
});

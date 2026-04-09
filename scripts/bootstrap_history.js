/**
 * bootstrap_history.js
 * ─────────────────────────────────────────────────────────────────────────────
 * TEK SEFERLİK çalıştırılır. Yahoo Finance'ten 1 yıllık günlük fiyat çeker:
 *   - GC=F  (Altın vadeli, USD/ons)
 *   - USDTRY=X (USD/TRY kuru)
 *   - EURTRY=X (EUR/TRY kuru)
 *   - BTC-USD, ETH-USD, BNB-USD, SOL-USD, XRP-USD, DOGE-USD, LTC-USD
 *
 * Mevcut history.json'daki hourly[] verisine dokunmaz.
 * daily[], monthly[], yearly[] alanlarını bootstrap eder.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const fs    = require('fs');
const https = require('https');
const path  = require('path');

const HISTORY_FILE = path.join(__dirname, '..', 'data', 'history.json');

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
                try { resolve(JSON.parse(raw)); }
                catch { resolve(null); }
            });
        });
        req.on('error', e => { console.error('Fetch error:', url, e.message); resolve(null); });
        req.setTimeout(15000, () => { req.destroy(); resolve(null); });
    });
}

function yahooUrl(symbol, range = '2y', interval = '1d') {
    return `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}`;
}

/** Yahoo Finance response → [{ts, price}] */
function parseYahoo(data) {
    try {
        const r = data.chart.result[0];
        const timestamps = r.timestamp;
        const closes     = r.indicators.quote[0].close;
        const result = [];
        for (let i = 0; i < timestamps.length; i++) {
            const p = closes[i];
            if (p == null || isNaN(p) || p <= 0) continue;
            result.push({ ts: timestamps[i] * 1000, price: p });
        }
        return result;
    } catch { return []; }
}

/** {ts,price}[] → daily[], monthly[] (son 12 ay), yearly[] (son 5 yıl) */
function buildArrays(series) {
    if (!series.length) return { daily: [], monthly: [], yearly: [] };

    // Günlük kapanışlar (max son 365 gün)
    const daily = series.slice(-365).map(x => parseFloat(x.price.toFixed(2)));

    // Aylık: her ayın son günü
    const byMonth = {};
    series.forEach(({ ts, price }) => {
        const d = new Date(ts);
        const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2,'0')}`;
        byMonth[key] = parseFloat(price.toFixed(2));
    });
    const monthly = Object.keys(byMonth).sort().slice(-12).map(k => byMonth[k]);

    // Yıllık: her yılın son kapanışı
    const byYear = {};
    series.forEach(({ ts, price }) => {
        const yr = new Date(ts).getUTCFullYear();
        byYear[yr] = parseFloat(price.toFixed(2));
    });
    const yearly = Object.keys(byYear).sort().slice(-5).map(k => byYear[k]);

    return { daily, monthly, yearly };
}

async function run() {
    // ── Mevcut history.json oku ───────────────────────────────────────────────
    let history = {};
    try {
        history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
        console.log('✅ Mevcut history.json yüklendi');
    } catch {
        console.log('ℹ️ history.json bulunamadı, sıfırdan oluşturuluyor');
    }

    // ── 1. USD/TRY ───────────────────────────────────────────────────────────
    console.log('\n⬇️  Yahoo Finance: USDTRY...');
    const usdtryData = await fetchJson(yahooUrl('USDTRY=X'));
    const usdtrySeries = parseYahoo(usdtryData || {chart:{result:[{timestamp:[],indicators:{quote:[{close:[]}]}}]}});
    console.log(`   ${usdtrySeries.length} günlük veri`);

    // ── 2. Altın (USD/ons) + USD/TRY → gram TRY ──────────────────────────────
    console.log('⬇️  Yahoo Finance: GC=F (altın vadeli)...');
    const goldData = await fetchJson(yahooUrl('GC=F'));
    const goldSeries = parseYahoo(goldData || {chart:{result:[{timestamp:[],indicators:{quote:[{close:[]}]}}]}});
    console.log(`   ${goldSeries.length} günlük altın verisi`);

    // USD/TRY lookup map by date string
    const usdMap = {};
    usdtrySeries.forEach(({ ts, price }) => {
        const key = new Date(ts).toISOString().slice(0, 10);
        usdMap[key] = price;
    });

    // Altın: USD/ons → TRY/gram
    const gramSeries = [];
    goldSeries.forEach(({ ts, price: goldUSD }) => {
        const dateStr = new Date(ts).toISOString().slice(0, 10);
        const usdTry  = usdMap[dateStr];
        if (!usdTry) return;
        const gramTRY = parseFloat(((goldUSD * usdTry) / 31.1035).toFixed(2));
        gramSeries.push({ ts, price: gramTRY });
    });
    console.log(`   ${gramSeries.length} gram-altın TRY noktası hesaplandı`);

    // ── 3. EUR/TRY ───────────────────────────────────────────────────────────
    console.log('⬇️  Yahoo Finance: EURTRY...');
    const eurtryData = await fetchJson(yahooUrl('EURTRY=X'));
    const eurtrySeries = parseYahoo(eurtryData || {chart:{result:[{timestamp:[],indicators:{quote:[{close:[]}]}}]}});
    console.log(`   ${eurtrySeries.length} günlük EUR/TRY verisi`);

    // ── 4. Kripto (USD) + USD/TRY ─────────────────────────────────────────────
    const CRYPTO_SYMBOLS = [
        { yahoo: 'BTC-USD', key: 'btc',  name: 'Bitcoin'   },
        { yahoo: 'ETH-USD', key: 'eth',  name: 'Ethereum'  },
        { yahoo: 'BNB-USD', key: 'bnb',  name: 'BNB'       },
        { yahoo: 'SOL-USD', key: 'sol',  name: 'Solana'    },
        { yahoo: 'XRP-USD', key: 'xrp',  name: 'XRP'       },
        { yahoo: 'DOGE-USD',key: 'doge', name: 'Dogecoin'  },
        { yahoo: 'LTC-USD', key: 'ltc',  name: 'Litecoin'  },
    ];

    const cryptoSeriesMap = {};
    for (const { yahoo, key, name } of CRYPTO_SYMBOLS) {
        console.log(`⬇️  Yahoo Finance: ${yahoo}...`);
        const cData = await fetchJson(yahooUrl(yahoo));
        const series = parseYahoo(cData || {chart:{result:[{timestamp:[],indicators:{quote:[{close:[]}]}}]}});
        // USD → TRY
        const tryS = series.map(({ ts, price }) => {
            const dateStr = new Date(ts).toISOString().slice(0, 10);
            const usdTry  = usdMap[dateStr];
            if (!usdTry) return null;
            return { ts, price: parseFloat((price * usdTry).toFixed(2)) };
        }).filter(Boolean);
        cryptoSeriesMap[key] = tryS;
        console.log(`   ${tryS.length} ${name} TRY noktası`);
    }

    // ── Mevcut history.json'ı güncelle ───────────────────────────────────────
    function merge(assetKey, series) {
        if (!series.length) return;
        const arrays = buildArrays(series);
        if (!history[assetKey]) history[assetKey] = { hourly: [], daily: [], monthly: [], yearly: [] };
        // hourly'e dokunma — sadece daily/monthly/yearly bootstrap et
        // Ama mevcut veri varsa ve daha uzunsa koruyalım
        if (arrays.daily.length   > (history[assetKey].daily   || []).length)   history[assetKey].daily   = arrays.daily;
        if (arrays.monthly.length > (history[assetKey].monthly || []).length)   history[assetKey].monthly = arrays.monthly;
        if (arrays.yearly.length  > (history[assetKey].yearly  || []).length)   history[assetKey].yearly  = arrays.yearly;
    }

    // Gram altın
    if (gramSeries.length) {
        merge('gram-altin', gramSeries);
        // Diğer TL altın türleri için gram altın baz alıp katsayılarla tahmin
        // (history sadece çizgi grafik için kullanılıyor, yaklaşık olması yeterli)
        const GOLD_RATIOS = {
            'ceyrek-altin':     0.25 * 7.216,  // ~1.804
            'yarim-altin':      0.5  * 7.216,  // ~3.608
            'tam-altin':        1.0  * 7.216,  // ~7.216 (22 ayar, ~7.216 gram)
            'cumhuriyet-altini':6.6,            // yaklaşık
            'ata-altin':        7.0,
            'resat-altin':      7.2,
            'hamit-altin':      7.2,
            'gram-has-altin':   1.0,
            '14-ayar-altin':    0.585,
            '18-ayar-altin':    0.750,
            '22-ayar-bilezik':  0.917,
        };
        for (const [key, ratio] of Object.entries(GOLD_RATIOS)) {
            const scaled = gramSeries.map(({ ts, price }) => ({ ts, price: parseFloat((price * ratio).toFixed(2)) }));
            merge(key, scaled);
        }
        console.log('\n✅ Altın türleri bootstrap edildi');
    }

    // USD / EUR kuru
    if (usdtrySeries.length) {
        merge('USD', usdtrySeries);
        console.log('✅ USD bootstrap edildi');
    }
    if (eurtrySeries.length) {
        merge('EUR', eurtrySeries);
        console.log('✅ EUR bootstrap edildi');
    }

    // Kripto
    for (const [key, series] of Object.entries(cryptoSeriesMap)) {
        merge(key, series);
        console.log(`✅ ${key.toUpperCase()} bootstrap edildi`);
    }

    // ── Meta ─────────────────────────────────────────────────────────────────
    history['_meta'] = {
        ...history['_meta'],
        bootstrapped_at: new Date().toISOString(),
        bootstrap_source: 'Yahoo Finance (GC=F, USDTRY=X, EURTRY=X, crypto USD pairs)'
    };

    fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2), 'utf8');
    console.log(`\n✅ data/history.json kaydedildi`);

    // Özet yazdır
    const keys = Object.keys(history).filter(k => k !== '_meta');
    console.log(`\n📊 Özet:`);
    keys.forEach(k => {
        const h = history[k];
        console.log(`  ${k.padEnd(20)} daily=${h.daily?.length||0}  monthly=${h.monthly?.length||0}  yearly=${h.yearly?.length||0}`);
    });
}

run().catch(err => {
    console.error('❌ Hata:', err);
    process.exit(1);
});

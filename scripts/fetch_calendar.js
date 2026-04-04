/**
 * fetch_calendar.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Her 6 saatte GitHub Actions tarafından çalıştırılır.
 * Finnhub economic_calendar endpoint'inden ekonomik takvim verisi çeker.
 * FINNHUB_KEY secret gerekir (finnhub.io → ücretsiz kayıt → API Key).
 *
 * Çıktı: data/calendar.json
 * ─────────────────────────────────────────────────────────────────────────────
 */

const fs    = require('fs');
const https = require('https');
const path  = require('path');

const OUTPUT_FILE  = path.join(__dirname, '..', 'data', 'calendar.json');
const FINNHUB_KEY  = process.env.FINNHUB_KEY || '';

// ── Yardımcı: HTTP GET ────────────────────────────────────────────────────────
function fetchJson(url) {
    return new Promise(resolve => {
        const req = https.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0',
                'X-Finnhub-Token': FINNHUB_KEY
            }
        }, res => {
            let raw = '';
            res.on('data', c => raw += c);
            res.on('end', () => {
                try { resolve({ status: res.statusCode, data: JSON.parse(raw) }); }
                catch { resolve(null); }
            });
        });
        req.on('error', () => resolve(null));
        req.setTimeout(12000, () => { req.destroy(); resolve(null); });
    });
}

// ── Tarih formatı: YYYY-MM-DD ─────────────────────────────────────────────────
function toDateStr(d) {
    return d.toISOString().split('T')[0];
}

// ── Önemi yüksek ülkeler ──────────────────────────────────────────────────────
// TR için direkt veri olmayabilir — küresel önemli açıklamalar alınır
const IMPORTANT_COUNTRIES = ['US', 'EU', 'GB', 'TR', 'DE', 'CN', 'JP'];
const IMPACT_LABELS = { '1': 'Düşük', '2': 'Orta', '3': 'Yüksek' };

// ── Ana fonksiyon ─────────────────────────────────────────────────────────────
async function run() {
    if (!FINNHUB_KEY) {
        console.warn('⚠️  FINNHUB_KEY secret bulunamadı. data/calendar.json güncellenmedi.');
        process.exit(0);
    }

    // Bugün + 7 gün aralığı
    const from = new Date();
    const to   = new Date();
    to.setDate(to.getDate() + 7);

    const url = `https://finnhub.io/api/v1/calendar/economic?from=${toDateStr(from)}&to=${toDateStr(to)}&token=${FINNHUB_KEY}`;
    console.log(`📅 Ekonomik takvim çekiliyor: ${toDateStr(from)} → ${toDateStr(to)}`);

    const res = await fetchJson(url);
    if (!res || res.status !== 200 || !res.data) {
        console.warn('⚠️  Finnhub yanıt vermedi veya erişim reddedildi — atlanıyor');
        process.exit(0);
    }
    if (res.data.error) {
        console.warn(`⚠️  Finnhub hata: ${res.data.error} — atlanıyor`);
        process.exit(0);
    }

    const rawEvents = res.data.economicCalendar || [];
    console.log(`  Ham veri: ${rawEvents.length} etkinlik`);

    // Filtrele: sadece önemli ülkeler + impact 2-3
    const events = rawEvents
        .filter(e => IMPORTANT_COUNTRIES.includes(e.country) && parseInt(e.impact || 0) >= 2)
        .map(e => ({
            id:       `${e.country}-${e.event}-${e.time}`.replace(/\s+/g, '-').toLowerCase().slice(0, 32),
            country:  e.country || '',
            event:    e.event   || '',
            time:     e.time    || '',
            impact:   IMPACT_LABELS[String(e.impact)] || 'Bilinmiyor',
            impactNum: parseInt(e.impact || 0),
            actual:   e.actual   != null ? String(e.actual)   : null,
            estimate: e.estimate != null ? String(e.estimate) : null,
            prev:     e.prev     != null ? String(e.prev)     : null,
            unit:     e.unit     || ''
        }))
        // Tarihe göre sırala (en yakın önce)
        .sort((a, b) => new Date(a.time) - new Date(b.time));

    const output = {
        _meta: {
            updated_at: new Date().toISOString(),
            range_from: toDateStr(from),
            range_to:   toDateStr(to),
            count: events.length,
            source: 'Finnhub Economic Calendar'
        },
        events
    };

    fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2), 'utf8');
    console.log(`✅ data/calendar.json kaydedildi (${events.length} etkinlik)`);
}

run().catch(err => { console.error('❌ Hata:', err); process.exit(1); });

/**
 * fetch_calendar.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Her 6 saatte GitHub Actions tarafından çalıştırılır.
 * ForexFactory gayri resmi JSON feed'inden ekonomik takvim verisi çeker.
 * Key veya kayıt gerektirmez.
 *
 * Kaynak: https://nfs.faireconomy.media/ff_calendar_thisweek.json
 *         https://nfs.faireconomy.media/ff_calendar_nextweek.json
 *
 * Çıktı: data/calendar.json
 * ─────────────────────────────────────────────────────────────────────────────
 */

const fs    = require('fs');
const https = require('https');
const path  = require('path');

const OUTPUT_FILE = path.join(__dirname, '..', 'data', 'calendar.json');

// Önemli ülke/para birimleri
const IMPORTANT_CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'CNY', 'CHF', 'All'];
const HIGH_IMPACT_ONLY = ['High', 'Medium'];

// ── Yardımcı: HTTP GET ────────────────────────────────────────────────────────
function fetchJson(url) {
    return new Promise(resolve => {
        const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
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

// ── Impact sayıya çevir (sıralama için) ──────────────────────────────────────
const IMPACT_NUM = { 'High': 3, 'Medium': 2, 'Low': 1, 'Holiday': 0 };

// ── Impact Türkçe ─────────────────────────────────────────────────────────────
const IMPACT_TR = { 'High': 'Yüksek', 'Medium': 'Orta', 'Low': 'Düşük', 'Holiday': 'Tatil' };

// ── Ana fonksiyon ─────────────────────────────────────────────────────────────
async function run() {
    const urls = [
        'https://nfs.faireconomy.media/ff_calendar_thisweek.json',
        'https://nfs.faireconomy.media/ff_calendar_nextweek.json'
    ];

    console.log('📅 ForexFactory ekonomik takvim çekiliyor...');

    const results = await Promise.all(urls.map(fetchJson));
    let allEvents = [];

    results.forEach((res, i) => {
        if (!res || res.status !== 200 || !Array.isArray(res.data)) {
            console.warn(`⚠️  ${i === 0 ? 'Bu hafta' : 'Gelecek hafta'} verisi alınamadı`);
            return;
        }
        console.log(`  ${i === 0 ? 'Bu hafta' : 'Gelecek hafta'}: ${res.data.length} etkinlik`);
        allEvents = allEvents.concat(res.data);
    });

    if (allEvents.length === 0) {
        console.warn('⚠️  Hiç veri alınamadı — atlanıyor');
        process.exit(0);
    }

    // Filtrele: önemli para birimleri + Medium/High impact
    const events = allEvents
        .filter(e => IMPORTANT_CURRENCIES.includes(e.country) && HIGH_IMPACT_ONLY.includes(e.impact))
        .map(e => ({
            id:        `${e.country}-${e.title}-${e.date}`.replace(/\s+/g, '-').toLowerCase().slice(0, 40),
            country:   e.country   || '',
            event:     e.title     || '',
            time:      e.date      || '',
            impact:    IMPACT_TR[e.impact] || e.impact,
            impactNum: IMPACT_NUM[e.impact] || 0,
            actual:    e.actual    || null,
            estimate:  e.forecast  || null,
            prev:      e.previous  || null,
            unit:      ''
        }))
        .sort((a, b) => new Date(a.time) - new Date(b.time));

    const now = new Date();
    const nextWeek = new Date();
    nextWeek.setDate(now.getDate() + 14);

    const output = {
        _meta: {
            updated_at: now.toISOString(),
            range_from: now.toISOString().split('T')[0],
            range_to:   nextWeek.toISOString().split('T')[0],
            count:      events.length,
            source:     'ForexFactory (nfs.faireconomy.media)'
        },
        events
    };

    fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2), 'utf8');
    console.log(`✅ data/calendar.json kaydedildi (${events.length} etkinlik)`);
}

run().catch(err => { console.error('❌ Hata:', err); process.exit(1); });

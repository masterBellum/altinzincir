/**
 * build_history.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Her saat GitHub Actions tarafından çalıştırılır.
 * data/current.json'daki anlık fiyatları okuyup data/history.json'a ekler.
 *
 * Rollup mantığı (foto 2):
 *   1 saat    → hourly[]  : son 24 giriş tutulur (intraday grafik)
 *   Gece 00:00 → daily[]  : son saatin fiyatı günün kapanışı olur, hourly korunur (kayan 24)
 *   7 gün dolunca          : 8. gün silinir (rolling 7-day pencere)
 *   Ay sonu    → monthly[]: o günün fiyatı aylık kapanış olur, daily'den çıkarılır
 *   12 ay dolunca          : 13. ay silinir
 *   Yıl sonu   → yearly[] : son monthly fiyatı yıllık kapanış olur
 *   5 yıl dolunca          : 6. yıl silinir
 * ─────────────────────────────────────────────────────────────────────────────
 */

const fs   = require('fs');
const path = require('path');

const CURRENT_FILE = path.join(__dirname, '..', 'data', 'current.json');
const HISTORY_FILE = path.join(__dirname, '..', 'data', 'history.json');

// ── Zaman yardımcıları (UTC) ──────────────────────────────────────────────────
// SIMDI: yalnizca test icin saat enjeksiyonu (ISO). Uretimde tanimsiz.
const now          = process.env.SIMDI ? new Date(process.env.SIMDI) : new Date();
const nowSn        = Math.floor(now.getTime() / 1000);

/**
 * Gunluk kayit: gun siniri 06:00 UTC (Turkiye 09:00).
 *
 * ESKIDEN "su an saat 06 mi" diye bakiliyordu. Bu is saatte bir calismasi
 * gerekirken GitHub zamanlayicisi gunde 4-5 kez calistiriyor; calisma 06:xx'e
 * denk gelmezse o gunun kapanisi HIC yazilmiyordu. Olculen: 25 Eylul - 11 Ekim
 * 2026 arasindaki 17 gunde yalnizca 7 gunluk nokta, Eylul ay sonu da kacti.
 *
 * SIMDI: "son gunluk kayittan beri gun siniri gecildi mi" diye bakiliyor.
 * 06:00'dan sonraki ILK calisma, saat kac olursa olsun kapanisi yazar.
 * Ay / yil kapanisi da ayni: yeni aya (yila) girildikten sonraki ilk gunluk
 * kayit, biten ayin (yilin) kapanisidir.
 */
const GUN_SINIRI_SAAT = 6;
/** 06:00 UTC'de degisen "islem gunu" (YYYY-MM-DD). */
function islemGunu(d) {
    return new Date(d.getTime() - GUN_SINIRI_SAAT * 3600 * 1000).toISOString().slice(0, 10);
}


// ── Dosyaları yükle ───────────────────────────────────────────────────────────
let current = {};
try {
    current = JSON.parse(fs.readFileSync(CURRENT_FILE, 'utf8'));
    delete current['_meta'];
} catch (e) {
    console.error('❌ data/current.json okunamadı:', e.message);
    process.exit(1);
}

let history = {};
try {
    history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
} catch {
    console.log('ℹ️ data/history.json bulunamadı, sıfırdan oluşturuluyor');
    history = {};
}

// ── Gun siniri gecildi mi? ────────────────────────────────────────────────────
const sonGunluk  = history['_meta']?.last_midnight ? new Date(history['_meta'].last_midnight) : null;
const bugun      = islemGunu(now);
const sonGun     = sonGunluk ? islemGunu(sonGunluk) : null;
const isMidnight = sonGun === null || bugun > sonGun;
const isMonthEnd = isMidnight && sonGun !== null && bugun.slice(0, 7) !== sonGun.slice(0, 7);
const isYearEnd  = isMonthEnd && bugun.slice(0, 4) !== sonGun.slice(0, 4);

console.log(`⏰ ${now.toISOString()} | islemGunu=${bugun} sonKayit=${sonGun} | dailyRollup=${isMidnight} | monthEnd=${isMonthEnd} | yearEnd=${isYearEnd}`);

/**
 * Saklanacak hassasiyet. Eskiden her sey 2 ondaliga yuvarlaniyordu: SHIB
 * (0,000263 TL) 0 olarak yaziliyor, grafik yazicisi sifirlari attigi icin
 * grafigi bos kaliyordu; ruble (0,5876) 0,59'da basamak basamak gidiyordu.
 * 100'un altinda 6 anlamli basamak.
 */
function yuvarla(v) {
    return v >= 100 ? parseFloat(v.toFixed(2)) : parseFloat(v.toPrecision(6));
}

// ── Her varlık için rollup ────────────────────────────────────────────────────
let updatedCount = 0;

Object.entries(current).forEach(([key, asset]) => {
    const price = asset.current;
    if (!price || isNaN(price) || price <= 0) return;

    // history kaydı yoksa oluştur
    if (!history[key]) {
        history[key] = { hourly: [], daily: [], monthly: [], yearly: [] };
    }
    const h = history[key];
    if (!Array.isArray(h.hourly))  h.hourly  = [];
    // hourlyTs: hourly[] ile AYNI uzunlukta, her fiyatın toplandığı an (epoch sn).
    // Neden gerekli: hourly dizisi yalnızca sayı tutuyordu, zaman bilgisi yoktu.
    // Uygulama bu yüzden noktaları "son 24 saate eşit dağılmış" varsayıyor ve
    // grafik tooltip'inde YANLIŞ saat gösteriyordu (ilk nokta için 15 saate
    // varan hata). Ayrıca cron gecikmeleri nedeniyle noktalar zaten eşit
    // aralıklı değil.
    if (!Array.isArray(h.hourlyTs)) h.hourlyTs = [];
    if (!Array.isArray(h.daily))   h.daily   = [];
    if (!Array.isArray(h.monthly)) h.monthly = [];
    if (!Array.isArray(h.yearly))  h.yearly  = [];
    // hourlyTs ile ayni gerekce, uzun araliklar icin: HAFTA/AY/YIL grafikleri de
    // noktalarin "esit dagilmis" oldugunu varsayamaz. Gun atlandiginda (cron
    // gecikmesi, is akisi hatasi) turetilen tarih sessizce kayar; gercek damga
    // kayarsa bile dogru kalir.
    if (!Array.isArray(h.dailyTs))   h.dailyTs   = [];
    if (!Array.isArray(h.monthlyTs)) h.monthlyTs = [];
    if (!Array.isArray(h.yearlyTs))  h.yearlyTs  = [];

    // ── 1. Her saat: fiyatı hourly'e ekle (max 24, son 24 saat) ───────────────────────────
    h.hourly.push(yuvarla(price));
    h.hourlyTs.push(nowSn);
    if (h.hourly.length > 24) h.hourly = h.hourly.slice(-24);
    if (h.hourlyTs.length > 24) h.hourlyTs = h.hourlyTs.slice(-24);
    // Eski kayıtlarda hourlyTs yok. Diziyi SIFIRLAMAK yerine hizalamayı koruyacak
    // şekilde eşitle: bilinmeyen eski girişler için başa null koy, fazlaysa baştan
    // kırp. (İlk sürümde sıfırlanıyordu; bu yüzden dizi hiçbir zaman birikemiyordu.)
    // Yazıcı yalnızca TÜM damgalar geçerliyse times alanını üretir, dolayısıyla
    // null'lar geçici olarak times yazılmamasına yol açar — eski girişler
    // döngüden çıkınca kendiliğinden düzelir.
    while (h.hourlyTs.length < h.hourly.length) h.hourlyTs.unshift(null);
    if (h.hourlyTs.length > h.hourly.length) h.hourlyTs = h.hourlyTs.slice(-h.hourly.length);

    // "Son 24 KAYIT" "son 24 SAAT" demek degil: GitHub zamanlayicisi bu isi
    // saatte bir degil 3-6 saatte bir calistiriyor, 24 kayit 2 gunu asiyordu
    // ve GUN grafigi 18-20 Ekim'i gosteriyordu (2026-10-20). Damgasi olan
    // girislerde 24 saatten eskileri at; grafik cizilebilsin diye en az 2 kalsin.
    const sinir = nowSn - 24 * 3600;
    let ilk = h.hourlyTs.findIndex(t => t !== null && t >= sinir);
    if (ilk === -1) ilk = h.hourlyTs.length;
    ilk = Math.min(ilk, Math.max(0, h.hourly.length - 2));
    if (ilk > 0) { h.hourly = h.hourly.slice(ilk); h.hourlyTs = h.hourlyTs.slice(ilk); }

    // ── 2. İlk kez oluşturuluyorsa daily'i şimdiki fiyatla seed'le ─────────────
    if (h.daily.length === 0) {
        h.daily.push(yuvarla(price));
        h.dailyTs.push(nowSn);
    }

    // ── 3. Gece yarısı: günün kapanışını daily'e ekle ────────────────────────
    if (isMidnight) {
        // Son hourly fiyatı = günün kapanışı
        const dailyClose = h.hourly.length > 0
            ? h.hourly[h.hourly.length - 1]
            : yuvarla(price);

        // Ay sonu mu? → monthly'e al
        if (isMonthEnd) {
            h.monthly.push(dailyClose);
            h.monthlyTs.push(nowSn);
            if (h.monthly.length > 60) h.monthly = h.monthly.slice(-60);
            if (h.monthlyTs.length > 60) h.monthlyTs = h.monthlyTs.slice(-60);
            console.log(`  📅 [AY SONU] ${key}: ${dailyClose} → monthly`);

            // Yıl sonu mu? → yearly'e al
            if (isYearEnd) {
                h.yearly.push(dailyClose);
                h.yearlyTs.push(nowSn);
                if (h.yearly.length > 5) h.yearly = h.yearly.slice(-5);
                if (h.yearlyTs.length > 5) h.yearlyTs = h.yearlyTs.slice(-5);
                console.log(`  🗓️  [YIL SONU] ${key}: ${dailyClose} → yearly`);
            }
        }

        // Her gün (ay sonu da dahil) daily'e ekle — son 1825 gün tut (5 yıl)
        h.daily.push(dailyClose);
        h.dailyTs.push(nowSn);
        if (h.daily.length > 1825) h.daily = h.daily.slice(-1825);
        if (h.dailyTs.length > 1825) h.dailyTs = h.dailyTs.slice(-1825);

        // hourly BILEREK temizlenmiyor; zaten son 24 kayitla sinirli (kayan pencere).
        // Eskiden burada sifirlaniyordu: gun siniri sonrasi seri 2 noktanin altina
        // dusunce fetch_current.js "gun" dosyasini Yahoo'nun 5 dk verisiyle
        // dolduruyordu. Hafta sonu bu, CUMANIN egrisinin "bugun" diye gosterilmesi
        // demekti (olculen: 2026-10-18 pazar 07:37 UTC, gram altin GUN grafigi).
        console.log(`  🌅 [GUN] ${key}: ${dailyClose} → daily (${h.daily.length})`);
    }

    // Eski kayitlarda damga dizileri yok. hourlyTs'de oldugu gibi SIFIRLAMA
    // yerine hizalamayi koru: bilinmeyen eski girisler icin basa null koy,
    // fazlaysa bastan kirp. Yazici tum damgalar gecerli degilse times
    // uretmiyor, yani null'lar dizi dolana kadar times'i geciktirir — dogru
    // olan da bu, uydurmak degil.
    for (const [seri, damga] of [['daily', 'dailyTs'], ['monthly', 'monthlyTs'], ['yearly', 'yearlyTs']]) {
        while (h[damga].length < h[seri].length) h[damga].unshift(null);
        if (h[damga].length > h[seri].length) h[damga] = h[damga].slice(-h[seri].length);
    }

    updatedCount++;
});

// ── Meta bilgisi ──────────────────────────────────────────────────────────────
history['_meta'] = {
    updated_at: now.toISOString(),
    last_midnight: isMidnight ? now.toISOString() : (history['_meta']?.last_midnight || null),
    last_month_end: isMonthEnd ? now.toISOString() : (history['_meta']?.last_month_end || null),
    last_year_end:  isYearEnd  ? now.toISOString() : (history['_meta']?.last_year_end  || null),
};

// ── Kaydet ────────────────────────────────────────────────────────────────────
fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
const tmpHist = HISTORY_FILE + '.tmp';
// Minify: dosya ~174 bin sayıdan oluşuyor ve girintili yazıldığında her sayı
// kendi satırında boşluklarla saklanıyordu — 2.74 MB'ın yarısı biçimlendirme.
// Saatte bir yeniden yazıldığı için repo büyümesine doğrudan yansıyor.
// Bu dosyayı hiçbir insan okumuyor (app varlık başına küçük dosyaları çekiyor,
// fetch_current.js ise JSON.parse ediyor). bootstrap_history.js zaten minify yazıyor.
fs.writeFileSync(tmpHist, JSON.stringify(history), 'utf8');
fs.renameSync(tmpHist, HISTORY_FILE);
console.log(`\n✅ data/history.json kaydedildi (${updatedCount} varlık güncellendi)`);

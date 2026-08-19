# AltınZincir — Veri Deposu

Bu depo, **AltınZincir** Android uygulamasının fiyat verisini üretir ve GitHub Pages
üzerinden yayınlar. Ayrıca kökteki `index.html` bir web panosu olarak aynı veriyi kullanır.

```
GitHub Actions  →  scripts/*.js  →  data/*.json  →  GitHub Pages  →  Android app + web panosu
```

---

## Yayınlanan veri

| Dosya | İçerik | Üreten | Sıklık |
|---|---|---|---|
| `data/current.json` | 97 varlık: altın, döviz, kripto | `fetch_current.js` | 5 dk (hedef) |
| `data/history.json` | Rollup biriktirici (hourly/daily/monthly/yearly) | `build_history.js` | 1 saat |
| `data/history/*.json` | Varlık başına grafik serisi (`{key}-{gun\|hafta\|ay\|yil}.json`) | `fetch_current.js` | 1 saat |
| `data/news.json` | 50 haber, kategori kotalı | `fetch_news.js` | 30 dk |
| `data/economic-calendar.json` | Ekonomik takvim | `fetch_calendar.js` | 6 saat |

> **Not:** Uygulamada takvim artık TradingView gömülü widget'ıyla gösteriliyor;
> `economic-calendar.json` şu an uygulama tarafından kullanılmıyor.

---

## Workflow'lar

| Workflow | Tetikleyici | Yazdığı dosya |
|---|---|---|
| `prices.yml` | 5 dk cron (yedek) + `repository_dispatch: fetch-prices` | `data/current.json` |
| `history.yml` | Saatlik + `build-history` | `data/history.json`, `data/history/` |
| `news.yml` | 30 dk + `fetch-news` | `data/news.json` |
| `calendar.yml` | 6 saat + `fetch-calendar` | `data/economic-calendar.json` |
| `bootstrap.yml` | Yalnızca manuel | `data/history.json` (tek seferlik dolum) |

**Cron gerçeği:** GitHub scheduled cron'u ağır throttle ediyor — `*/5` ayarlıyken
ölçülen gerçek aralık **~20–57 dakika**. Bu yüzden asıl tetikleme harici bir cron
servisinden `repository_dispatch` ile yapılmalı (test edildi: 20 saniyede tetikliyor).
`schedule` yalnızca yedek olarak duruyor.

**Push çakışması:** Beş workflow da aynı ref'e push ediyor. Her birinde
`pull --rebase --autostash` + `git rebase --abort` + 5 denemeli backoff var.
`rebase --abort` olmadan yarım kalan rebase repoyu kilitliyor ve tüm denemeler
aynı hatayla düşüyordu.

---

## Veri kaynakları ve neden bunlar

| Kaynak | Ne için | Durum |
|---|---|---|
| canlidoviz + Truncgil | Altın (14), gümüş, gram platin | `robots.txt` izinli, halka açık |
| Truncgil → TCMB → fawazahmed0 | Döviz (61) | TCMB resmî kamu verisi; diğerleri serbest |
| CoinGecko | Kripto (20) | Ücretsiz katman, **atıf şartlı** (uygulamada Ayarlar › Veri Kaynakları) |
| Google News RSS | Haberler | Başlık + kaynağa link |
| ForexFactory | Ekonomik takvim | Anahtarsız haftalık feed |

### Neden BIST hissesi ve emtia YOK

`data/current.json` **herkese açık** bir adreste yayınlanıyor; yani veriyi sadece
kullanmıyor, **yeniden dağıtıyoruz**. İncelenen sağlayıcıların tamamı bunu
şartlarında yasaklıyor: Yahoo Finance (resmî olmayan endpoint), Twelve Data,
Finnhub, EODHD, Financial Modeling Prep ve Borsa İstanbul'un kendi veri sözleşmesi.

Bu yüzden:
- **97 BIST hissesi** → uygulamada TradingView gömülü widget'ına taşındı
  (veri bizde saklanmaz, TradingView kendi lisansıyla gösterir)
- **14 Yahoo emtiası** → uygulamadaki Emtia sekmesi kaldırıldı; gümüş ve gram platin
  Altın sekmesine alındı (ikisi de Türk kaynağından, gram cinsinden)

**Tek istisna:** `PL=F` hâlâ Yahoo'dan çekiliyor ama **dosyaya yazılmıyor** —
yalnızca `gram-platin`'in yüzde değişimini hesaplamakta kullanılıyor, çünkü
Truncgil'in `Change` alanı hafta sonu/tatilde bayat kalıyor.

---

## Bilinmesi gereken tasarım kararları

**`SKIP_HISTORY=1`** — `prices.yml` bu bayrakla çalışır. Bayraksız çalıştırma
`data/history/` altında ~962 dosya değiştiriyor; 5 dakikalık kadansta bu günde
~277 bin dosya yazımı demek. Bayrakla fiyat işi yalnızca `current.json` yazar
(1 dosya), run süresi 110 sn → 64 sn düşer. `history.yml` **bilerek bayraksız**
çalışır: `data/history/` üretiminin tek noktası orasıdır.

**`hourlyTs`** — `hourly[]` yalnızca sayı tutuyordu, zaman bilgisi yoktu.
Uygulama noktaların "aralığa eşit dağıldığını" varsayıp grafik tooltip'inde
15 saate varan yanlış saat gösteriyordu. Artık `hourly` ile aynı uzunlukta
epoch-saniye dizisi tutuluyor ve `data/history/*-gun.json` içine `times` olarak
yazılıyor. Eski girişler için `null` konur; yazıcı yalnızca **tüm** damgalar
geçerliyse `times` üretir.

> `hourly` dizisi **gece yarısında değil, 06:00 UTC'de** sıfırlanır
> (`build_history.js`, `isMidnight = utcHour === 6`).

**`_meta.counts` / `stale_assets`** — Bir kaynak çökerse eski değerler korunur
(kasıtlı), ama `updated_at` yine tazelenir. Bu, donmuş fiyatları "az önce
güncellendi" gibi gösteriyordu. Artık kategori bazlı sayaç ve varlık başına `ts`
damgası var; sıfır olan kategori veya 2 saatten eski varlık `_meta.warnings`'e düşer
ve uygulama tazelik göstergesi yerine uyarı gösterir.

**`history.json` minify** — Dosya ~174 bin sayıdan oluşuyor; girintili yazıldığında
boyutun yarısı biçimlendirmeydi. Saatte bir yeniden yazıldığı için repo büyümesine
doğrudan yansıyordu. 2.74 MB → 1.32 MB, kayıpsız.

---

## Kurulum

**Secret'lar:** `NEWSAPI_KEY` (opsiyonel, `fetch_news.js` yedeği).
NewsAPI ücretsiz katmanı **yalnızca geliştirme** içindir — üretimde kullanılmamalı.

**Harici cron (önerilen):** GitHub cron throttle'ı yüzünden 5 dakikalık kadans için
harici bir zamanlayıcı gerekir:

```
POST https://api.github.com/repos/masterBellum/altinzincir/dispatches
Authorization: Bearer <fine-grained PAT, Contents: read+write>
Accept: application/vnd.github+json
Body: {"event_type":"fetch-prices"}
```

Başarılı yanıt: HTTP 204.

# Butikspriser, kampanjpris och automatisk återgång

Denna version lägger till prisredigering i personalpanelen. **Pris-API:et och personalpanelens formulär är implementerade, men Cloudflare Workern som skapar Stripe Checkout-sessioner finns inte i GitHub-repot. Workern måste uppdateras innan den tar dessa priser.** Ändra inte webbplatsens visade priser till kampanjpriset förrän Stripe också hämtar dem.

## Installera

1. Kör [`migrations/20261127170000_catalog_prices.sql`](./migrations/20261127170000_catalog_prices.sql) **en gång** i [Supabase SQL Editor](https://supabase.com/dashboard/project/bevemgjmcdkcbtsxezsa/sql/new). Kräver den befintliga lagerdatabasen inklusive `archived_at`.
2. Publicera webbplatsens ändringar från `ai/john` till `main`.
3. Öppna personalpanelen > **Artikelpriser & kampanjer**, fyll i ordinarie pris för en artikel och spara.
4. Vill du sälja artikeln i webbutiken, ange dess butikskoppling (t.ex. `exile`, samma ID som används av kassan). Blanda inte ihop ID:t med artikelnumret `EXILE-001`.
5. Valfritt: ange lägre kampanjpris **och** slutdatum/tid tillsammans. Sluttiden anges i webbläsarens lokala tid och sparas som `timestamptz`. Kampanjpris gäller fram till (men inte vid) sluttidpunkten; pris-API:et återgår sedan till ordinarie pris utan någon schemalagd körning.

Belopp sparas som heltal i **öre**, valutan är **SEK**. Bara aktiv personal kan redigera priser via RPC. Publik RPC returnerar endast publicerade prisfält, aldrig lagerkostnader, personal eller historik. Historiska prisändringar finns i `catalog_price_events`.

## Kontrollera pris-API:et

RPC via PostgREST:

`GET https://bevemgjmcdkcbtsxezsa.supabase.co/rest/v1/rpc/public_catalog_prices`

Ange HTTP-header `apikey: <SUPABASE_PUBLISHABLE_KEY>`. För offentligt pris-API kan anon-nyckeln användas (aldrig `service_role`). Resultat (exempel):

```json
[{
  "storefront_key": "exile",
  "name": "Exile – Grundspelet",
  "regular_price_ore": 24900,
  "effective_price_ore": 19900,
  "sale_price_ore": 19900,
  "sale_ends_at": "2026-12-15T22:59:00+00:00"
}]
```

Detta är exempeldata, inte ett verkligt API-svar.

## Koppla till Cloudflare Worker / Stripe

Nuvarande kassa skickar bara produkt-ID och antal, och Stripe-sessionen skapas i er befintliga Worker: `https://spinroll-stripe-api.john-svartstrom.workers.dev`. **För att få säkra automatiska priser måste Workern, vid varje nytt köpförsök:**

1. Ta emot och validera produkt-ID/antal enligt sin befintliga godkända produktlista (t.ex. `exile`, 1–10).
2. Hämta `public_catalog_prices()` från Supabase via HTTP. Använd endast den publika nyckeln. Behandla tomt/felaktigt svar som ett fel och vägra skapa en Checkout Session.
3. Matcha exakt `storefront_key` med kundvagnens produkt-ID och använd `effective_price_ore` som Stripe `line_items[].price_data.unit_amount`. **Använd aldrig ett pris som skickas från webbläsaren.**
4. Skapa Stripe Embedded Checkout med er nuvarande `sk_test_` i Worker-secret och bibehåll befintlig CORS-konfiguration, returadress, fraktinställningar och övriga säkerhetskontroller.
5. Visa samma API-pris på produktsidan, i kundvagnen och i kassan. Håll visade priser synkade med nästa Checkout-session. När ett kampanjpris har gått ut beräknar Supabase direkt ordinarie pris igen, även om en kund har en gammal flik öppen. Påbörjade Stripe Checkout-sessioner ändrar inte pris i efterhand.

### Kodskelett för befintlig Worker

```js
async function fetchServerPrices(supabaseUrl, publishableKey) {
  const response = await fetch(supabaseUrl + "/rest/v1/rpc/public_catalog_prices", {
    headers: { apikey: publishableKey, Authorization: "Bearer " + publishableKey },
    cache: "no-store"
  });
  if (!response.ok) throw new Error("Prislistan kunde inte hämtas");
  const rows = await response.json();
  if (!Array.isArray(rows)) throw new Error("Ogiltig prislista");
  return new Map(rows.map(row => [row.storefront_key, row]));
}

// Exempel INUTI Workerns befintliga validerade artikelloop:
// const product = serverPrices.get(item.id);
// if (!product || !Number.isSafeInteger(product.effective_price_ore)
//     || product.effective_price_ore <= 0) throw new Error("Produkten saknar giltigt pris");
// const lineItem = {
//   price_data: {
//     currency: "sek",
//     unit_amount: product.effective_price_ore,
//     product_data: { name: product.name }
//   },
//   quantity: item.quantity
// };
```

**Workern finns inte i detta repo.** Vi kan inte verifiera dess befintliga implementation eller ändra/deploya den härifrån. Be ägaren exportera Cloudflare Worker-koden, så integrerar vi detta i rätt funktion utan att förstöra Checkout. Det är bättre än att gissa fram en ersättnings-Worker och riskera betalningar.

**Viktigt:** Denna lösning skapar priset i **nya Stripe Checkout-sessioner**, inte nya permanenta Stripe Price-objekt. Det är ett fullt giltigt sätt att ta rätt betalt. Om ni i stället behöver permanenta Stripe-pris-ID:n, prissynk i Dashboard och prisändringshistorik där krävs en separat serverintegration som skapar nya Stripe Price-objekt (Stripe Price-belopp kan inte ändras på befintliga Price-objekt).

## Aktivera färdig Worker och prisvisning

Nu finns en komplett Worker i [`cloudflare/spinroll-stripe-api.js`](../cloudflare/spinroll-stripe-api.js). Den är baserad på den Worker-kod som används i dag och använder Stripe **testläge**. Inga ändringar görs i ditt Cloudflare-konto automatiskt när GitHub uppdateras.

**Rekommenderad ordning:**

1. Kör pris-SQL-migrationen i Supabase.
2. Skapa/spara ett ordinarie pris på artikeln i personalpanelen. Ange `exile` i fältet **Butikskoppling (produkt-ID)**.
3. Kontrollera att `public_catalog_prices()` returnerar artikeln med positivt `effective_price_ore`.
4. Kopiera hela [Worker-koden](../cloudflare/spinroll-stripe-api.js) till **Cloudflare → Workers & Pages → spinroll-stripe-api → Edit code**. Behåll Cloudflare-secreten `STRIPE_SECRET_KEY` (`sk_test_...`); ange den aldrig i koden. Kontrollera att gamla Worker-koden är säkerhetskopierad.
5. Klicka **Deploy** i Cloudflare. Kassan använder från och med då det aktuella priset från Supabase, inte det tidigare fasta Stripe-pris-ID:t. Om pris hämtas felaktigt visas ett fel i stället för ett felaktigt debiterat belopp.
6. Slå ihop `ai/john` med `main`. Nu hämtar `exile.html`, `kundvagn.js` och `checkout.html` samma publika prislista via `butikspriser.js`.
7. Testa ett Stripe **testköp** med ordinarie pris. Lägg därefter en kort kampanj i panelen och testa att priset återgår efter sluttiden. Kontrollera även att kundvagnen, kassan och den skapade Stripe-sessionen visar samma belopp.

**Viktigt:** Jag har inte själv publicerat Cloudflare Workern eller kört SQL i din Supabase-databas. Den sista synkroniseringen sker först efter dessa två manuella steg. Befintliga Checkout-sessioner och gamla Stripe Price-objekt ändras inte.

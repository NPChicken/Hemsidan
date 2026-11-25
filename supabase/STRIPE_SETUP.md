# SpinRoll UF – koppla Stripe TEST till personalpanelen

**Status:** Koden finns på GitHub-grenen `ai/john`, men en webhook blir **inte aktiv** förrän Edge Function är publicerad och en Stripe-destination har skapats. Inga skarpa betalningar tas emot här.

Kassan i `checkout.html` använder redan en Cloudflare Worker för att skapa Stripe Embedded Checkout-sessioner. **Ändra inte kassan eller Workern** för den här integrationen.

## 1. Skapa Edge Function i Supabase

1. Öppna [Supabase Edge Functions](https://supabase.com/dashboard/project/bevemgjmcdkcbtsxezsa/functions).
2. Välj **Deploy a new function → Via Editor**.
3. Döp funktionen till **`stripe-orders`**.
4. Klistra in koden från [`supabase/functions/stripe-orders/index.ts`](./functions/stripe-orders/index.ts).
5. Klicka **Deploy**.
6. Gå till funktionens **Details/Settings** och stäng av **Verify JWT**. Detta är avsiktligt för en Stripe-webhook: Stripe skickar ingen Supabase-JWT, men själva funktionen verifierar Stripes signatur. Stäng **inte** av signaturkontrollen i koden.

Funktionens endpoint är:

`https://bevemgjmcdkcbtsxezsa.supabase.co/functions/v1/stripe-orders`

**OBS:** Koden behöver hemliga miljövariabler innan den kan ta emot betalningar. Det är okej om ett anrop misslyckas innan steg 3 är färdigt.

## 2. Skapa webhook-destination i Stripe sandbox/testläge

1. Öppna [Stripe Workbench → Webhooks](https://dashboard.stripe.com/webhooks) och välj **SpinRoll UF sandbox** (testläge, **inte** live).
2. Välj **Add destination** / **Create an event destination**.
3. Välj händelser av typen **Snapshot events** (fullständiga eventobjekt), **Events on your account**.
4. Välj **endast**:
   - `checkout.session.completed`
   - `checkout.session.async_payment_succeeded`
5. Välj destinationstyp **Webhook endpoint/HTTPS** och klistra in funktions-URL:en ovan.
6. När destinationen har skapats, hitta **Signing secret** (börjar `whsec_`). **Skicka aldrig den till någon eller lägg den i GitHub.**

## 3. Lägg in hemligheter i Supabase

Gå till [Supabase Edge Functions → Secrets](https://supabase.com/dashboard/project/bevemgjmcdkcbtsxezsa/settings/functions) (exakta menyval kan variera). Lägg in två nya hemligheter:

| Namn | Värde |
| --- | --- |
| `STRIPE_API_KEY` | Stripes **hemliga TEST-API-nyckel**, börjar `sk_test_` |
| `STRIPE_WEBHOOK_SIGNING_SECRET` | Webhook-destinationens **Signing secret**, börjar `whsec_` |

Hitta Stripe-testnyckeln under Stripe **Developers/Workbench → API keys**. Projektets inbyggda Supabase-serveråtkomst används av funktionen; ingen ytterligare Supabase-nyckel ska skickas till webbläsaren.

## 4. Kontrollera kopplingen

1. Öppna Stripe-sandboxen och gör ett **riktigt testköp** via SpinRolls kassa med ett Stripe-testkort. Ett genererat, simulerat Stripe-event kan sakna en faktisk Checkout Session; använd en verklig testsession för första fullständiga testet.
2. Kontrollera **Stripe → Webhooks → Event deliveries**. Händelsen `checkout.session.completed` ska ge HTTP **200**. En 401 betyder oftast att `Verify JWT` fortfarande är aktiverat; 400 kan betyda felaktig webhook-signatur/secret; 500 kan bero på API-nycklar, databasfel eller att sessionen inte kan hämtas.
3. Kontrollera **Supabase → Edge Functions → stripe-orders → Logs** om något blir fel. Lämna gärna feltexten utan API-nycklar eller personuppgifter till felsökning.
4. Öppna personalpanelen och klicka **Uppdatera** under *Senaste beställningarna*. Testordern ska visas med produkt, belopp och de kunduppgifter som Stripe faktiskt samlade in.

### Viktigt

- All orderdata från testköp ligger i `public.orders` och `public.order_items` med RLS. Bara aktiva `staff_members` får läsa.
- Endast signerade testevent accepteras av webhooken, och samma `stripe_checkout_session_id` kan inte skapa dubbla ordrar.
- Fulfillment-status är **skrivskyddad** i denna version. Funktionen för att markera en order som packad/skickad kräver separat serverkontrollerad behörighet.
- Betalningsreturer/refunds, leveransaviseringar och automatisk synk av äldre testordrar är **inte** byggda ännu.
- En fraktadress syns bara om den redan samlas in av Checkout-sessionen. Om den saknas behöver kassans Worker konfigureras för leveransadress.
- Migrationen `supabase/migrations/20261125210000_create_staff_orders.sql` ska redan vara körd i databasen och er personal ska vara registrerad.
- Använd bara anonyma/fiktiva kunduppgifter vid testning, aldrig verkliga betaluppgifter eller skarpa kunddata.

# Lagerstatus och trygg lagerbegränsning i SpinRolls Stripe-testkassa

## Vad ändras?

- `index.html` och `exile.html` visar **exemplar i lager** från den artikel vars butikskoppling är `website`.
- Vid 0 i lager eller om lagerstatus inte går att hämta spärras köpknappen.
- Kundvagn och checkout begränsas av aktuellt lager. Detta är bara en användarvänlig kontroll, **inte det verkliga översäljningsskyddet**.
- Cloudflare Worker anropar en **serverauktoriserad, atomisk** Supabase-RPC innan Stripe Checkout Session skapas. Den tar omedelbart bort reserverade exemplar från tillgängligt saldo, så två samtidiga kunder inte kan reservera samma exemplar.
- Betald Stripe-webhook markerar reservationen `paid`. `checkout.session.expired` returnerar reservationen till samma lagerplatser.
- Samtliga antal och händelser journalförs som `checkout_reservation` och `checkout_release`.

## Måste göras i denna ordning

1. Kör [`20261127230000_storefront_stock_reservations.sql`](./migrations/20261127230000_storefront_stock_reservations.sql) **en gång** i Supabase SQL Editor efter alla tidigare lager- och prismigrationer. Kontrollera att Exiles aktiva artikel har `storefront_key = 'website'`, och att lagerantal på aktiva lagerplatser är korrekt.
2. I Cloudflare Worker `spinroll-stripe-api`, konfigurera **Secret** `SUPABASE_SERVICE_ROLE_KEY` med service-role-nyckeln från Supabase-projektets API Keys. Den är **mycket hemlig** och får ALDRIG publiceras i GitHub, HTML, e-post, chatt eller klientkod. Den kan läsa/skriva databasen och måste endast användas i Workerns servermiljö.
3. Ersätt Workerns kod med [`cloudflare/spinroll-stripe-api.js`](../cloudflare/spinroll-stripe-api.js) och **Deploy**. Behåll befintlig Cloudflare-secret `STRIPE_SECRET_KEY` med `sk_test_...`.
4. Uppdatera/deploya Supabase Edge Function `stripe-orders` med [`supabase/functions/stripe-orders/index.ts`](./functions/stripe-orders/index.ts). Behåll befintliga server-Secrets `STRIPE_API_KEY` och `STRIPE_WEBHOOK_SIGNING_SECRET`.
5. I Stripe Dashboard > Developers > Webhooks, se till att samma `stripe-orders`-endpoint tar emot **`checkout.session.completed`**, **`checkout.session.async_payment_succeeded`** och **`checkout.session.expired`**. Testläge ska användas.
6. **Först därefter** publicera hemsidan från GitHub-branchen `ai/john` till `main`. Rensa webbläsarens cache vid behov.

**VIKTIGT:** Publicera inte bara frontend utan att uppdatera Worker och webhook. Om webhookens `checkout.session.expired`-händelser inte levereras fastnar reserverade exemplar som otillgängliga. Att frigöra reservationer baserat på tid utan att verifiera Stripe-sessionens status kan riskera översäljning och görs därför inte.

## Testfall i Stripe TESTLÄGE

1. Registrera en aktiv artikel med kopplingen `website` och t.ex. **2 st** på en aktiv lagerplats.
2. Öppna hemsidan i ett privat fönster: **2 exemplar i lager**, köpknappen aktiv.
3. Starta Stripe Checkout för 2 st (betala inte). Kontrollera i ett annat fönster att hemsidan visar **Slut i lager** och att annan kassa inte kan reservera ett exemplar.
4. Genomför en testbetalning (för en ny reservation om du först avslutat sessionen). Kontrollera att den signerade webhooken har status 200, att ordern syns i personalpanelen och att reservationen har `paid`.
5. Låt en annan test-Checkout Session gå ut efter cirka 30 minuter och kontrollera att `checkout.session.expired` levererats med 200, att reserverat antal har återkommit.
6. Kontrollera att flera parallella försök att köpa sista exemplaret ger högst **en** lyckad reservation.

## SQL för att kontrollera reservationer (endast i Supabase SQL Editor)

```sql
select id, item_id, quantity, stripe_checkout_session_id,
       status, created_at, paid_at, released_at
from public.storefront_stock_reservations
order by created_at desc limit 30;
```

`reserved` är ännu obetald/aktuell. `paid` är betald. `released` är frigjord. Om en reservation ligger som `reserved` länge efter att Stripe-sessionen har löpt ut, **kontrollera först Stripe-sessionens faktiska status och webhookleveranserna** innan någon manuell justering görs.

## Övriga begränsningar

- Integrationen är fortfarande **Stripe-testläge** och är endast kopplad till varan Exile (`website`).
- En öppen Stripe-session håller antal undanlagda tills den betalas eller går ut, även om besökaren lämnar sidan. Detta är avsiktligt: annars kan andra kunder hinna köpa samma exemplar.
- En offentlig kassa kan utsättas för automatiska reservationsförsök som tillfälligt blockerar lager. Sätt gärna Cloudflare-rate-limiting/botskydd på Worker-rutten innan skarp lansering.
- Personal ska inte inventera tillbaka reserverade exemplar under pågående Checkout-sessioner. Gör inventering efter att aktiva reservationer beaktats.
- Stripe ska inte köras i skarpt läge med denna testimplementation utan ny granskning av betal- och återbetalningsflöden.

# Platslösa reservationer – SpinRoll

## Skillnaden

**Fysiskt lager** finns på lagerplatser och ändras inte av att någon öppnar kassan eller betalar.
**Reserverade exemplar** är en separat spärr på TOTALT säljbara antal och tillhör ingen lagerplats.
När personal väljer en lagerplats till en betald order sker det fysiska uttaget exakt en gång.

Exempel: A=5, B=5, reserverade=2, säljbara=8. Inget av lagren har minskats.
Efter betalning väljer personal B: A=5, B=3, reserverade=0, säljbara=8.

Obetalda sessioner förblir reserverade tills avbrutet köp eller verifierad Stripe-expiry
(genom webhook eller den tidigare införda Cloudflare Cron-kontrollen).
En betald order förblir reserverad **utan 10-minuterstimeout** tills personal väljer lager.

## Mycket viktigt: driftsätt som en samlad ändring

1. **Gör detta i testmiljö och under ett tillfälligt köpstopp.** Stoppa nya köp medan SQL
   uppdateras och tills allt testats. Ta en databasbackup och kontrollera senaste
   ordrar och lagerplatser.
2. Installera först migrationsfilen
   `20261128000000_order_stock_location_assignment.sql` om den inte redan körts.
3. Kör **hela** `20261128010000_locationless_checkout_holds.sql` EN gång i Supabase SQL Editor.
   Den nya migrationen återför tidigare automatiska avdrag för öppna och ännu
   inte lagerplatstilldelade beställningar. Redan skickade ordrar eller ordrar
   med tidigare bekräftat lagerplatsval behåller sina historiska fysiska uttag.
   Om databasen inte kan återskapa tidigare lager utan konflikt avbryts migrationen.
4. Publicera uppdaterade `personal.js` från `ai/john` tillsammans med
   webbplatsens andra filer. Uppdatera cache med Ctrl+Shift+R.
5. Behåll den redan deployade Cloudflare Workern och Supabase Stripe-webhooken:
   deras RPC-anrop har samma namn men sköts nu av de nya databasfunktionerna.
   Cloudflare Cron Trigger (`* * * * *`) måste fortfarande vara aktiv för 10 minuter.
6. Återuppta testköp först när samtliga nedanstående tester passerat.

## Kontroll i Supabase SQL Editor

```sql
select si.name,
       coalesce((select sum(sl.quantity) from public.stock_levels sl where sl.item_id=si.id),0) as physical_total,
       coalesce((select sum(r.quantity) from public.storefront_stock_reservations r
           where r.item_id=si.id
             and (r.status='reserved' or (r.status='paid' and not r.stock_allocated))),0) as centrally_reserved
from public.stock_items si
where si.archived_at is null;
```

## Testa noga

- Lägg 5 exemplar på A och 5 på B. Hemsidan ska visa 10 säljbara.
- Starta en Checkout-session för 2 exemplar. **A ska fortfarande ha 5 och B 5**;
  hemsidan ska visa 8 säljbara. Ett samtidigt köp för 9 ska nekas.
- Avbryt köpet. Hemsidan ska åter visa 10 och båda lagerplatserna vara oförändrade.
- Genomför ett betalt testköp på 2. Webbplatsen visar fortfarande 8 säljbara;
  personalsidan visar **2 exemplar reserverade centralt**.
- Välj A på ordern. A ska nu ha 3, B 5, och hemsidan fortfarande visa 8.
- Byt till B innan ordern skickas. A ska bli 5 och B 3; hemsidan fortfarande 8.
- Försök skicka en betald order som saknar lagerplats: servern ska neka.
- Testa ett lager med färre exemplar än orderns antal. Servern ska neka utan ändrade saldon.
- Testa två samtidiga beställningar så att endast totala tillgängliga exemplar reserveras.

## Begränsningar

- SQL-versionen är byggd för nuvarande Stripe **testläge** och webbprodukten kopplad via `website`.
- Inget fysiskt lager dras innan personal gör ett lagerplatsval, men reserverade exemplar
  måste fortfarande finnas totalt fysiskt. Att försöka inventera bort ett reserverat
  exemplar ska avvisas av databasens lagerkontroll.
- Om ni tidigare **fysiskt packat/skickat** en betald testorder utan att sätta den
  till status Skickad i personalpanelen kan övergångsmigrationen inte upptäcka det.
  Rätta orderstatus och inventering före migrationen så att inget räknas dubbelt.
- Kundvagnens innehåll i localStorage är INTE en lagerreservation. Spärren börjar när
  Stripe Checkout-sessionen skapas.

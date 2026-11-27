# SpinRoll – exakt inköpsparti & Instagram/TikTok-tidslinje

## Det som nu är byggt på ai/john

### Inköpskostnad per leverans

Vinstberäkningen utgår inte längre från ett genomsnitt för hela produkten.
Varje **ny** betald order kan kopplas till ett **mottaget, kostnadsfört
inköpsparti på vald lagerplats** innan ordern markeras **Packad**.

Exempel:
- Leverans A: 10 Exile, total inköpskostnad 1 000 kr ⇒ 100 kr/st.
- Leverans B: 10 Exile, total inköpskostnad 1 400 kr ⇒ 140 kr/st.
- Order 1 säljs för 249 kr, kopplas till A ⇒ bruttomarginal 149 kr.
- Order 2 säljs för 249 kr, kopplas till B ⇒ bruttomarginal 109 kr.

När ordern markeras **Packad** sparas den aktuella leveransens styckkostnad
som ett **oföränderligt kostnadsögonblick** på ordern. Ändringar av
framtida inköpspriser ändrar därför inte redan packade ordrars kostnad.
Antalet kopplade sålda exemplar kan inte överstiga antalet i leveransen.
Databasen kontrollräknar detta i samma transaktion som fysiskt lageruttag.

Om ordern inte har ett verifierat parti visas vinsten som **Ej komplett**
i stället för att uppskatta eller anta att kostnaden är noll.
Tidigare packade testordrar får därför okänd kostnad tills ett särskilt,
granskat historiskt backfill-flöde byggs. **Detta är inte nettoresultat**:
moms, frakt, betalningsavgifter, returer och övriga kostnader saknas.
I första versionen väljs ett parti per order. Order med många olika
partier behöver ett framtida flerradsgränssnitt.

**Installera:**
1. Ta Supabase-backup.
2. Kör `20261128060000_order_delivery_batch_costs.sql` i Supabase SQL Editor
   **en gång**, efter befintliga analys- och lagermigrationer.
3. Publicera `personal.html`, `personal.js`, `personal.css` från `ai/john`.
4. Testa en ny betald testorder: välj lagerplats, sedan mottaget
   inköpsparti (leveransen måste ha inköpskostnad och inte vara märkt
   som test), sedan **Packad**.
5. Kontrollera att vinst per produkt är lika med historiskt försäljningspris
   minus **just den valda leveransens** inköpskostnad.

### Automatisk 30-dagarstidslinje

En **separat** Cloudflare Worker är förberedd i
`cloudflare/spinroll-social-sync.js`. Den använder de officiella
plattformarnas API:er och sparar publiceringsdatum för de senaste
30 dagarnas inlägg. Webbläsaren läser sedan från Supabase; inga
kontonycklar lagras i HTML eller personal.js.

Konton:
- Instagram: https://www.instagram.com/spinrolluf
- TikTok: https://www.tiktok.com/@spinroll.uf

**Autentisering krävs innan inlägg kan hämtas på riktigt.**

Instagram:
1. Säkerställ att kontot är professionellt (Business/Creator).
2. Skapa en Meta Developer-app med Instagram API med Instagram Login,
   bevilja `instagram_business_basic` för **@spinrolluf**.
3. Skaffa en Instagram User access token, hantera långlivade token och förnyelse.
4. Spara den som Cloudflare **Secret** `INSTAGRAM_ACCESS_TOKEN`.
   Workern kontrollerar att det auktoriserade kontots användarnamn verkligen
   är `spinrolluf` innan inlägg läggs in.

TikTok:
1. Skapa app på TikTok for Developers, aktivera Login Kit och Display API,
   godkänn `user.info.basic` och `video.list`.
2. Låt kontot **@spinroll.uf** själv auktorisera appen med TikTok OAuth
   och hämta dess **refresh token**. Inga åtkomstnycklar får klistras
   in i GitHub eller i denna chatt.
3. I nya Cloudflare Workern, skapa privat KV namespace och bind det
   som `SOCIAL_TOKENS`. Workern sparar TikToks **roterade**
   refresh token där vid varje synkronisering.
4. Lägg till Cloudflare **Secrets**:
   - `TIKTOK_CLIENT_KEY`
   - `TIKTOK_CLIENT_SECRET`
   - `TIKTOK_INITIAL_REFRESH_TOKEN`
   - `TIKTOK_EXPECTED_OPEN_ID` (rekommenderas; ID för det auktoriserade kontot)
5. Workern använder refresh-token grant och läser egna videor från
   TikToks `/v2/video/list/`.

Supabase:
1. Kör `20261128070000_automatic_social_post_sources.sql` **en gång**
   efter `20261128050000_staff_sales_marketing_analytics.sql`.
2. Lägg `SUPABASE_SERVICE_ROLE_KEY` som **Cloudflare Secret** i den
   **nya separata** Workern. Den ska ALDRIG till frontend eller GitHub.
3. Publicera `cloudflare/spinroll-social-sync.js` som en separat Worker
   (inte i kassan!) och aktivera **Cron Trigger** `0 */6 * * *`
   så att inläggen hämtas var sjätte timme.
4. Se Cloudflare-loggar och Supabase `social_sync_status` för
   senast lyckad hämtning per plattform. Personalpanelen visar om
   en kanal ännu inte kopplats in.

**Ingen första synkronisering har körts.** Kontona behöver autentiseras
av den som äger dem. Om token förfaller eller behörigheter saknas
visas senaste status; ingen inläggsdata uppfinns. Personal kan
fortfarande lägga till historiska inlägg manuellt.

Officiell dokumentation:
- Instagram Media: https://developers.facebook.com/docs/instagram-platform/reference/instagram-media/v21.0/
- TikTok Display API: https://developers.tiktok.com/docs/en/display-api-get-started
- TikTok List Videos: https://developers.tiktok.com/docs/en/tiktok-api-v2-video-list/
- TikTok OAuth token management: https://developers.tiktok.com/docs/en/oauth-user-access-token-management/

## Praktiskt test

1. Instagram/TikTok är ej anslutna: inget påhittat inlägg syns; panelen
   visar att respektive konto väntar på anslutning.
2. Anslut ett konto: efter Cron-körning dyker autentiska
   publiceringsdatum upp; upprepade synkroniseringar dubblerar inte inlägg.
3. Välj **30 dagar** i tidslinjen och kontrollera 3 riktiga poster mot
   motsvarande officiella profil. Äldre inlägg visas inte i detta intervall.
4. Gör två testköp kopplade till olika mottagna leveranser med olika
   inköpskostnad och jämför bruttovinsten.

## Uppdatering: testleveranser för Stripe-testköp

Efter ordinarie inköpskostnadsmigration **60000** kör
[`20261128080000_allow_test_delivery_costs.sql`](./migrations/20261128080000_allow_test_delivery_costs.sql)
i Supabase SQL Editor. Publicera sedan uppdaterade `personal.html`,
`personal.js` och `personal.css` från `ai/john`.

- Inköpspartiväljaren är nu normalstor (46 px hög).
- Mottagna leveranser med `is_test=true` och registrerad kostnad
  kan väljas för **Stripe-testordrar** och märks **TEST** i menyn.
- Även vanliga mottagna leveranser kan fortfarande väljas vid testköp.
  Detta påverkar bara kostnadskopplingen; inventering/testdata bör hållas åtskilda.
- Plats och artikel måste matcha ordern, och lageruttag sker fortfarande
  först vid **Packad**.
- Gamla redan packade ordrar tilldelas inte kostnad retroaktivt;
  prova med en **ny** order efter installationen.

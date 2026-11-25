# SpinRoll UF – Supabase orderdatabas (testläge)

Den här katalogen innehåller en **SQL-migration** för personalmedlemskap och ordertabeller. Den innehåller **inga hemliga nycklar eller kunddata**. Migrationen är sparad i GitHub men **är inte automatiskt installerad i Supabase-projektet**.

## Vad migrationen skapar

- `public.staff_members`: godkända Supabase Auth-användare, identifierade via `auth.users.id`, med `active` och `role`.
- `public.orders`: betalda Stripe Checkout-ordrar, belopp i **öre**, kund- och leveransuppgifter samt leveransstatus.
- `public.order_items`: produkt- och antalsrader till en order.
- RLS på samtliga tabeller. Endast aktiv, inloggad personal kan **läsa** ordrar. Ingen webbläsare får skapa, redigera eller radera ordrar.

## Installera migrationen

**Rekommenderat:** Använd Supabase CLI och migrationer, så att historiken i databasen och GitHub förblir synkroniserade.

1. Hämta projektet från GitHub med migrationen i din arbetskopia.
2. Installera Supabase CLI och logga in med `supabase login`.
3. Länka rätt Supabase-projekt via `supabase link --project-ref bevemgjmcdkcbtsxezsa`.
4. Testa migrationen på en lokal Supabase-databas först och kör `supabase db push` för att tillämpa den på projektet. Granska SQL-filen innan du godkänner ändringen.

Du kan **alternativt** kopiera SQL-koden till Supabase → SQL Editor → New query → Run, men det kringgår migrationshistoriken och kan skapa framtida konflikter med `supabase db push`. Välj en metod, inte båda.

## Lägg till personal

1. Skapa respektive användare under **Authentication → Users** och bekräfta e-postadressen.
2. Öppna Supabase → SQL Editor med projektadministratörens behörighet.
3. Kontrollera användar-ID med:

```sql
select id, email
from auth.users
order by created_at desc;
```

4. Lägg in **endast** de konton som ska ha personalåtkomst. Exempel med en adress – kontrollera e-postadressen och ändra till rätt medarbetare:

```sql
insert into public.staff_members (user_id, role, active)
select id, 'admin', true
from auth.users
where lower(email) = lower('john.svartstrom@hitachigymnasiet.se')
on conflict (user_id) do update
set role = excluded.role, active = excluded.active;
```

Gör likadant för Julius, Wictor och Ida med `role = 'staff'`. Kontrollera sedan:

```sql
select u.email, s.role, s.active
from public.staff_members s
join auth.users u on u.id = s.user_id
order by u.email;
```

Om `insert` ger **0 rows** i den första SQL-frågan eller om någon saknas i resultatet finns inte det Auth-kontot eller har en annan e-postadress. Rätta det innan fortsatt arbete.

### Inaktivera en medarbetare

Kör som administratör i SQL Editor:

```sql
update public.staff_members
set active = false
where user_id = (select id from auth.users where lower(email) = lower('medarbetare@example.com'));
```

Detta hindrar framtida databasanrop med orderbehörighet, även om personen fortfarande har en giltig Supabase-inloggning.

## Säkerhet och nästa steg

- Den tidigare mejllistan i `personal.js` var bara ett UI-filter. Personalkontroll ska göras med `staff_members` och **RLS**, inte mejladress från klienten.
- **Inga ordrar visas förrän Stripe-webhooken är byggd och verifierar att betalningen är genomförd.** Läs inte in Stripe-kundinformation direkt från webbläsaren.
- Spara **endast** de kunduppgifter ni behöver för att fullfölja beställningen. Spara aldrig kortuppgifter, Stripe-secret keys eller Supabase secret/service_role-nycklar i GitHub eller i `personal.js`.
- Webhook eller betrodd serverfunktion kan senare skriva med en Supabase secret key, som lagras i **serverns hemligheter**, och bör kontrollera signatur, betalstatus, testläge och idempotens.
- `stripe_checkout_session_id` är unik för att hindra dubbla registreringar av samma Checkout Session.
- Personalpanelen är i detta steg **endast en tom översikt**. Inga riktiga ordrar eller kunduppgifter hanteras.
- **Testa RLS** med inloggad aktiv personal, ej godkänd inloggad person samt anonym användare; kontrollera både `SELECT` och att `INSERT/UPDATE/DELETE` nekas innan riktiga kunduppgifter används.
- Planera gallring och hantering av personuppgifter enligt GDPR innan ni börjar ta emot skarpa beställningar.

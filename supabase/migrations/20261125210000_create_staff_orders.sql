-- SpinRoll UF: personalbehörighet och orderdatabas.
-- Avsedd för Supabase Postgres. Innehåller INGA kunduppgifter eller API-hemligheter.
-- Läggs till som migration; kör via Supabase CLI och testa RLS innan riktiga data förs in.
-- OBS: Detta är ett initialt schema för TESTLÄGE. Webhook och Stripe-synk är ännu inte inkopplade.

begin;

-- Det är användar-ID från Supabase Auth, inte e-post eller klientens JavaScript,
-- som avgör personalbehörighet. Endast administratör/service_role kan lägga till personal.
create table public.staff_members (
    user_id uuid primary key references auth.users(id) on delete cascade,
    role text not null default 'staff' check (role in ('staff', 'admin')),
    active boolean not null default true,
    created_at timestamptz not null default now()
);

-- Priser i öre, alltså 249 kr = 24900. Ingen kort-/betalningsinformation lagras.
-- stripe_checkout_session_id används senare som idempotent unik orderidentifierare.
create table public.orders (
    id uuid primary key default gen_random_uuid(),
    stripe_checkout_session_id text not null unique
        check (length(stripe_checkout_session_id) between 8 and 255),
    stripe_payment_intent_id text,
    stripe_mode text not null default 'test' check (stripe_mode in ('test', 'live')),
    customer_name text,
    customer_email text,
    shipping_name text,
    shipping_address_line1 text,
    shipping_address_line2 text,
    shipping_postal_code text,
    shipping_city text,
    shipping_country text,
    currency text not null default 'sek' check (currency ~ '^[a-z]{3}$'),
    amount_total integer not null check (amount_total >= 0),
    payment_status text not null default 'paid'
        check (payment_status in ('paid', 'refunded', 'partially_refunded')),
    fulfillment_status text not null default 'new'
        check (fulfillment_status in ('new', 'packing', 'shipped', 'cancelled')),
    stripe_created_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index orders_created_at_idx on public.orders (created_at desc);
create index orders_fulfillment_status_idx on public.orders (fulfillment_status);
create index orders_payment_intent_idx on public.orders (stripe_payment_intent_id);

create table public.order_items (
    id uuid primary key default gen_random_uuid(),
    order_id uuid not null references public.orders(id) on delete cascade,
    line_no integer not null check (line_no > 0),
    product_name text not null,
    product_reference text,
    quantity integer not null check (quantity > 0),
    unit_amount integer not null check (unit_amount >= 0),
    currency text not null default 'sek' check (currency ~ '^[a-z]{3}$'),
    unique (order_id, line_no)
);

create index order_items_order_id_idx on public.order_items (order_id);

-- Varje tabell i publikt exponerat schema ska skyddas med RLS.
alter table public.staff_members enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;

-- Ta bort klienträttigheter som kan finnas via Supabases standardprivilegier.
revoke all on table public.staff_members, public.orders, public.order_items
    from public, anon, authenticated;

-- Inloggad användare får bara läsa; endast admin/server får skriva.
grant select on table public.staff_members, public.orders, public.order_items
    to authenticated;
grant all on table public.staff_members, public.orders, public.order_items
    to service_role;

-- Varje användare får endast se SIN EGEN medlemskapsrad.
create policy "staff_read_own_membership"
    on public.staff_members for select
    to authenticated
    using (user_id = (select auth.uid()));

-- Aktiv personal får läsa orderdata.
-- Ingen INSERT/UPDATE/DELETE-policy: webbklienten kan inte skriva ordrar.
create policy "active_staff_read_orders"
    on public.orders for select
    to authenticated
    using (
        exists (
            select 1
            from public.staff_members as staff
            where staff.user_id = (select auth.uid())
              and staff.active = true
        )
    );

create policy "active_staff_read_order_items"
    on public.order_items for select
    to authenticated
    using (
        exists (
            select 1
            from public.staff_members as staff
            where staff.user_id = (select auth.uid())
              and staff.active = true
        )
    );

commit;

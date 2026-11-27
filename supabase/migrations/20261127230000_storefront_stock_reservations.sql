-- SpinRoll UF: publik lagerstatus och säkra Stripe-testreservationer.
-- OMKONSTRUERAD VERSION. Kör efter tidigare lager- och prismigrationer.
-- Alla förändringar sker atomiskt inom en enda transaktion.
begin;

create table public.storefront_stock_reservations (
    id uuid primary key default gen_random_uuid(),
    item_id uuid not null references public.stock_items(id),
    quantity integer not null check (quantity between 1 and 10),
    stripe_checkout_session_id text unique,
    status text not null default 'reserved'
        check (status in ('reserved','paid','released')),
    created_at timestamptz not null default now(),
    paid_at timestamptz,
    released_at timestamptz
);
create table public.storefront_stock_reservation_lines (
    reservation_id uuid not null references public.storefront_stock_reservations(id),
    item_id uuid not null references public.stock_items(id),
    location_id uuid not null references public.stock_locations(id),
    quantity integer not null check (quantity > 0),
    primary key (reservation_id, location_id)
);
create index storefront_stock_reservations_status_idx
    on public.storefront_stock_reservations(status,created_at);

alter table public.storefront_stock_reservations enable row level security;
alter table public.storefront_stock_reservation_lines enable row level security;
revoke all on public.storefront_stock_reservations,
    public.storefront_stock_reservation_lines from public, anon, authenticated;
grant all on public.storefront_stock_reservations,
    public.storefront_stock_reservation_lines to service_role;

-- Samma stock_events-journal som inventering och inleverans.
alter table public.stock_events drop constraint if exists stock_events_reason_check;
alter table public.stock_events add constraint stock_events_reason_check
    check (reason in ('manual_count','delivery','delivery_reversal',
                     'checkout_reservation','checkout_release'));

-- Endast aggregerat antal för aktiva butiksartiklar, inga interna lagerplatser.
create function public.public_storefront_stock()
returns table (storefront_key text, available_quantity bigint)
language sql stable security definer set search_path = ''
as $stock_public$
    select cp.storefront_key,
        coalesce(sum(sl.quantity),0)::bigint
    from public.catalog_prices cp
    join public.stock_items si on si.id = cp.item_id and si.archived_at is null
    left join public.stock_levels sl on sl.item_id = si.id
    where cp.storefront_key is not null
    group by cp.storefront_key;
$stock_public$;

-- Reservta exakt tillgängligt lager i samma databastransaktion.
-- INGEN public/authenticated klient får exekvera skrivfunktionerna.
create or replace function public.reserve_storefront_stock(
    p_storefront_key text, p_quantity integer
)
returns uuid
language plpgsql security definer set search_path = ''
as $reserve$
declare
    v_item uuid;
    v_available bigint;
    v_left integer;
    v_id uuid;
    v_location record;
    v_take integer;
begin
    if auth.role() is distinct from 'service_role' then
        raise exception 'Endast kassaservern får reservera lager' using errcode = '42501';
    end if;
    if p_quantity is null or p_quantity not between 1 and 10 then
        raise exception 'Ogiltigt antal' using errcode = '22023';
    end if;

    -- FOR UPDATE på artikeln synkroniserar med både samtidiga reservationer
    -- och personalens lagerfunktioner, som tar FOR SHARE på artikeln.
    select si.id into v_item
    from public.catalog_prices cp
    join public.stock_items si on si.id = cp.item_id
    where cp.storefront_key = p_storefront_key
      and si.archived_at is null
    for update of si;

    if not found then
        raise exception 'Produkten säljs inte i butiken' using errcode = '22023';
    end if;

    select coalesce(sum(sl.quantity), 0)
    into v_available
    from public.stock_levels sl
    where sl.item_id = v_item;

    if v_available < p_quantity then
        raise exception 'Inte tillräckligt många exemplar kvar i lager' using errcode = '23514';
    end if;

    insert into public.storefront_stock_reservations(item_id, quantity)
    values (v_item, p_quantity) returning id into v_id;

    v_left := p_quantity;
    for v_location in
        select location_id, quantity
        from public.stock_levels
        where item_id = v_item and quantity > 0
        order by location_id for update
    loop
        exit when v_left = 0;
        v_take := least(v_left, v_location.quantity);

        update public.stock_levels
        set quantity = quantity - v_take, updated_at = now()
        where item_id = v_item and location_id = v_location.location_id;

        insert into public.storefront_stock_reservation_lines(
            reservation_id, item_id, location_id, quantity
        ) values (v_id, v_item, v_location.location_id, v_take);

        insert into public.stock_events(
            item_id, location_id, previous_quantity, new_quantity, reason, actor_id
        ) values (
            v_item, v_location.location_id, v_location.quantity,
            v_location.quantity - v_take, 'checkout_reservation', null
        );
        v_left := v_left - v_take;
    end loop;

    if v_left <> 0 then
        raise exception 'Kunde inte slutföra reservationen' using errcode = '23514';
    end if;
    return v_id;
end;
$reserve$;

create function public.bind_checkout_stock_reservation(
    p_reservation_id uuid, p_stripe_session_id text
)
returns void language plpgsql security definer set search_path = ''
as $bind$
declare v_status text;
begin
    if auth.role() <> 'service_role' then
        raise exception 'Åtkomst nekad' using errcode = '42501';
    end if;
    if p_stripe_session_id is null or p_stripe_session_id !~ '^cs_test_[a-zA-Z0-9_]+$' then
        raise exception 'Ogiltig Stripe-session' using errcode = '22023';
    end if;
    select status into v_status from public.storefront_stock_reservations
    where id = p_reservation_id for update;
    if not found or v_status <> 'reserved' then
        raise exception 'Reservationen är inte aktiv' using errcode = '22023';
    end if;
    update public.storefront_stock_reservations
    set stripe_checkout_session_id = p_stripe_session_id
    where id = p_reservation_id
      and (stripe_checkout_session_id is null or stripe_checkout_session_id = p_stripe_session_id);
    if not found then
        raise exception 'Reservationen är redan bunden till en annan session'
            using errcode = '23514';
    end if;
end;
$bind$;

create function public.mark_checkout_stock_paid(
    p_reservation_id uuid, p_stripe_session_id text
)
returns void language plpgsql security definer set search_path = ''
as $paid$
declare v_res public.storefront_stock_reservations%rowtype;
begin
    if auth.role() <> 'service_role' then
        raise exception 'Åtkomst nekad' using errcode = '42501';
    end if;
    select * into v_res from public.storefront_stock_reservations
    where id = p_reservation_id for update;
    if not found or v_res.stripe_checkout_session_id is distinct from p_stripe_session_id then
        raise exception 'Betalningssessionen saknar giltig lagerreservation'
            using errcode = '23514';
    end if;
    if v_res.status = 'paid' then return; end if;
    if v_res.status <> 'reserved' then
        raise exception 'Betald reservation har redan släppts' using errcode = '23514';
    end if;
    update public.storefront_stock_reservations
    set status='paid', paid_at=now() where id=p_reservation_id;
end;
$paid$;

-- Används bara vid misslyckad Stripe-session eller signerad expired-webhook.
-- Returnerar exakt samma exemplar till samma lagerplatser. Idempotent.
create or replace function public.release_checkout_stock_reservation(
    p_reservation_id uuid, p_stripe_session_id text default null
)
returns void
language plpgsql security definer set search_path = ''
as $release$
declare
    v_res public.storefront_stock_reservations%rowtype;
    v_line record;
    v_old integer;
begin
    if auth.role() is distinct from 'service_role' then
        raise exception 'Åtkomst nekad' using errcode = '42501';
    end if;

    select * into v_res
    from public.storefront_stock_reservations
    where id = p_reservation_id
    for update;
    if not found then
        raise exception 'Reservationen saknas' using errcode = 'P0002';
    end if;
    if p_stripe_session_id is not null
       and v_res.stripe_checkout_session_id is not null
       and v_res.stripe_checkout_session_id <> p_stripe_session_id then
        raise exception 'Fel Stripe-session' using errcode = '23514';
    end if;

    if v_res.status = 'released' then return; end if;
    if v_res.status <> 'reserved' then
        raise exception 'Betald reservation kan inte frigöras' using errcode = '23514';
    end if;

    -- Artikellåset synkroniserar med nya reservationer och inventering.
    perform 1 from public.stock_items where id = v_res.item_id for update;

    for v_line in
        select location_id, quantity
        from public.storefront_stock_reservation_lines
        where reservation_id = p_reservation_id
        order by location_id
    loop
        select quantity into v_old
        from public.stock_levels
        where item_id = v_res.item_id and location_id = v_line.location_id
        for update;
        if v_old is null or v_old + v_line.quantity > 1000000 then
            raise exception 'Kunde inte återföra reserverat lager' using errcode = '23514';
        end if;

        update public.stock_levels
        set quantity = v_old + v_line.quantity, updated_at = now()
        where item_id = v_res.item_id and location_id = v_line.location_id;

        insert into public.stock_events(
            item_id, location_id, previous_quantity, new_quantity, reason, actor_id
        ) values (
            v_res.item_id, v_line.location_id, v_old,
            v_old + v_line.quantity, 'checkout_release', null
        );
    end loop;

    update public.storefront_stock_reservations
    set status = 'released', released_at = now()
    where id = p_reservation_id;
end;
$release$;

-- Reserverade exemplar har redan dragits från lagernivån. Förhindra att
-- någon därför arkiverar en artikel/lagerplats medan en kassa är öppen.
create or replace function public.archive_stock_item(p_item_id uuid)
returns void language plpgsql security definer set search_path = ''
as $archive_item$
begin
    perform public.assert_stock_staff();
    perform 1 from public.stock_items
    where id=p_item_id and archived_at is null for update;
    if not found then
        raise exception 'Artikeln saknas eller är redan arkiverad' using errcode = 'P0002';
    end if;
    if exists (
        select 1 from public.stock_levels
        where item_id=p_item_id and quantity>0
    ) or exists (
        select 1 from public.storefront_stock_reservations
        where item_id=p_item_id and status='reserved'
    ) then
        raise exception 'Artikeln har saldo eller reserverade exemplar' using errcode = '23514';
    end if;
    if exists (
        select 1 from public.incoming_stock
        where item_id=p_item_id and status='planned'
    ) then
        raise exception 'Artikeln har kommande leveranser' using errcode = '23514';
    end if;
    update public.stock_items set archived_at=now() where id=p_item_id;
end;
$archive_item$;

create or replace function public.archive_stock_location(p_location_id uuid)
returns void language plpgsql security definer set search_path = ''
as $archive_location$
begin
    perform public.assert_stock_staff();
    perform 1 from public.stock_locations
    where id=p_location_id and archived_at is null for update;
    if not found then
        raise exception 'Lagerplatsen saknas eller är redan arkiverad' using errcode = 'P0002';
    end if;
    if exists (
        select 1 from public.stock_levels
        where location_id=p_location_id and quantity>0
    ) or exists (
        select 1 from public.storefront_stock_reservation_lines l
        join public.storefront_stock_reservations r on r.id=l.reservation_id
        where l.location_id=p_location_id and r.status='reserved'
    ) then
        raise exception 'Lagerplatsen har saldo eller reserverade exemplar'
            using errcode = '23514';
    end if;
    if exists (
        select 1 from public.incoming_stock
        where location_id=p_location_id and status='planned'
    ) then
        raise exception 'Lagerplatsen har kommande leveranser' using errcode = '23514';
    end if;
    update public.stock_locations set archived_at=now() where id=p_location_id;
end;
$archive_location$;
revoke all on function public.public_storefront_stock() from public, authenticated;
grant execute on function public.public_storefront_stock() to anon, authenticated;
revoke all on function public.reserve_storefront_stock(text,integer),
    public.bind_checkout_stock_reservation(uuid,text),
    public.mark_checkout_stock_paid(uuid,text),
    public.release_checkout_stock_reservation(uuid,text)
    from public,anon,authenticated;
grant execute on function public.reserve_storefront_stock(text,integer),
    public.bind_checkout_stock_reservation(uuid,text),
    public.mark_checkout_stock_paid(uuid,text),
    public.release_checkout_stock_reservation(uuid,text)
    to service_role;
commit;

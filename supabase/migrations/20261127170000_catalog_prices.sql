-- SpinRoll UF: trygg prislista för nätbutiken och tidsstyrda kampanjpriser.
-- Krav: lagerdatabas, arkivering och aktiv personal i staff_members.
begin;

create table public.catalog_prices (
    item_id uuid primary key references public.stock_items(id) on delete restrict,
    storefront_key text unique,
    regular_price_ore integer not null check (regular_price_ore between 1 and 100000000),
    sale_price_ore integer check (sale_price_ore between 1 and 100000000),
    sale_ends_at timestamptz,
    updated_by uuid references auth.users(id) on delete set null,
    updated_at timestamptz not null default now(),
    constraint sale_both_or_neither check (
        (sale_price_ore is null and sale_ends_at is null)
        or (sale_price_ore is not null and sale_ends_at is not null)
    ),
    constraint sale_lower_than_regular check (
        sale_price_ore is null or sale_price_ore < regular_price_ore
    ),
    constraint valid_storefront_key check (
        storefront_key is null or storefront_key ~ '^[a-z0-9_-]{1,40}$'
    )
);

create table public.catalog_price_events (
    id bigint generated always as identity primary key,
    item_id uuid not null references public.stock_items(id),
    old_regular_price_ore integer,
    old_sale_price_ore integer,
    old_sale_ends_at timestamptz,
    new_regular_price_ore integer not null,
    new_sale_price_ore integer,
    new_sale_ends_at timestamptz,
    actor_id uuid references auth.users(id) on delete set null,
    created_at timestamptz not null default now()
);

alter table public.catalog_prices enable row level security;
alter table public.catalog_price_events enable row level security;

revoke all on public.catalog_prices, public.catalog_price_events from public, anon, authenticated;
grant select on public.catalog_prices, public.catalog_price_events to authenticated;
grant all on public.catalog_prices, public.catalog_price_events to service_role;

create policy "active_staff_read_catalog_prices" on public.catalog_prices for select to authenticated
using (exists (
    select 1 from public.staff_members s
    where s.user_id = (select auth.uid()) and s.active
));

create policy "active_staff_read_catalog_price_events" on public.catalog_price_events for select to authenticated
using (exists (
    select 1 from public.staff_members s
    where s.user_id = (select auth.uid()) and s.active
));

-- Bara aktiv personal kan sätta priser. Alla belopp är heltal i öre (SEK).
create function public.save_catalog_price(
    p_item_id uuid,
    p_regular_price_ore integer,
    p_sale_price_ore integer default null,
    p_sale_ends_at timestamptz default null,
    p_storefront_key text default null
)
returns void language plpgsql security definer set search_path = ''
as $$
declare
    v_old public.catalog_prices%rowtype;
    v_key text := nullif(trim(p_storefront_key),'');
begin
    perform public.assert_stock_staff();
    perform 1 from public.stock_items where id = p_item_id and archived_at is null for update;
    if not found then
        raise exception 'Artikeln finns inte eller är arkiverad' using errcode = '22023';
    end if;
    if p_regular_price_ore is null or p_regular_price_ore < 1 or p_regular_price_ore > 100000000 or
       (p_sale_price_ore is null) <> (p_sale_ends_at is null) or
       (p_sale_price_ore is not null and (p_sale_price_ore < 1 or p_sale_price_ore >= p_regular_price_ore)) or
       (p_sale_ends_at is not null and p_sale_ends_at <= now()) or
       (v_key is not null and v_key !~ '^[a-z0-9_-]{1,40}$') then
        raise exception 'Ogiltigt pris, kampanjslut eller butikskoppling' using errcode = '22023';
    end if;

    select * into v_old from public.catalog_prices where item_id = p_item_id for update;
    insert into public.catalog_prices (
        item_id,storefront_key,regular_price_ore,sale_price_ore,sale_ends_at,updated_by,updated_at
    ) values (
        p_item_id,v_key,p_regular_price_ore,p_sale_price_ore,p_sale_ends_at,auth.uid(),now()
    )
    on conflict (item_id) do update set
        storefront_key = excluded.storefront_key,
        regular_price_ore = excluded.regular_price_ore,
        sale_price_ore = excluded.sale_price_ore,
        sale_ends_at = excluded.sale_ends_at,
        updated_by = excluded.updated_by,
        updated_at = now();

    insert into public.catalog_price_events(
        item_id,old_regular_price_ore,old_sale_price_ore,old_sale_ends_at,
        new_regular_price_ore,new_sale_price_ore,new_sale_ends_at,actor_id
    ) values(
        p_item_id,v_old.regular_price_ore,v_old.sale_price_ore,v_old.sale_ends_at,
        p_regular_price_ore,p_sale_price_ore,p_sale_ends_at,auth.uid()
    );
end;
$$;

-- Allmänt läsbara enstaka produktpriser, aldrig intern lagerinformation.
-- Anropas av webbplatsen och i nästa steg av Stripe-Workern.
create function public.public_catalog_prices()
returns table(
    storefront_key text,
    name text,
    regular_price_ore integer,
    effective_price_ore integer,
    sale_price_ore integer,
    sale_ends_at timestamptz
)
language sql stable security definer set search_path = ''
as $$
    select p.storefront_key, i.name, p.regular_price_ore,
        case when p.sale_price_ore is not null and p.sale_ends_at > now()
             then p.sale_price_ore else p.regular_price_ore end as effective_price_ore,
        case when p.sale_price_ore is not null and p.sale_ends_at > now()
             then p.sale_price_ore else null end as sale_price_ore,
        case when p.sale_price_ore is not null and p.sale_ends_at > now()
             then p.sale_ends_at else null end as sale_ends_at
    from public.catalog_prices p
    join public.stock_items i on i.id = p.item_id
    where i.archived_at is null and p.storefront_key is not null;
$$;

revoke all on function public.save_catalog_price(uuid,integer,integer,timestamptz,text)
    from public, anon;
grant execute on function public.save_catalog_price(uuid,integer,integer,timestamptz,text)
    to authenticated;
revoke all on function public.public_catalog_prices() from public;
grant execute on function public.public_catalog_prices() to anon, authenticated;

commit;

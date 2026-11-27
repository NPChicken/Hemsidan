-- SpinRoll UF: lager, förvaringsplatser och planerade inleveranser.
-- Kör EFTER staff_members-migrationen. Bara aktiva personalkonton får skriva via RPC.
begin;

create table public.stock_items (
    id uuid primary key default gen_random_uuid(),
    name text not null check (length(trim(name)) between 1 and 120),
    sku text unique,
    unit text not null default 'st' check (length(trim(unit)) between 1 and 24),
    created_at timestamptz not null default now()
);

create table public.stock_locations (
    id uuid primary key default gen_random_uuid(),
    name text not null unique check (length(trim(name)) between 1 and 100),
    description text check (description is null or length(description) <= 500),
    created_at timestamptz not null default now()
);

create table public.stock_levels (
    item_id uuid not null references public.stock_items(id),
    location_id uuid not null references public.stock_locations(id),
    quantity integer not null default 0 check (quantity between 0 and 1000000),
    updated_at timestamptz not null default now(),
    primary key (item_id, location_id)
);

create table public.incoming_stock (
    id uuid primary key default gen_random_uuid(),
    item_id uuid not null references public.stock_items(id),
    location_id uuid not null references public.stock_locations(id),
    quantity integer not null check (quantity between 1 and 1000000),
    total_cost_ore bigint check (total_cost_ore between 0 and 100000000000),
    supplier text check (supplier is null or length(supplier) <= 150),
    expected_on date,
    notes text check (notes is null or length(notes) <= 1000),
    status text not null default 'planned' check (status in ('planned','received')),
    received_at timestamptz,
    created_by uuid references auth.users(id) on delete set null,
    created_at timestamptz not null default now()
);

create index incoming_stock_pending_idx on public.incoming_stock(status,expected_on);

create table public.stock_events (
    id bigint generated always as identity primary key,
    item_id uuid not null references public.stock_items(id),
    location_id uuid not null references public.stock_locations(id),
    previous_quantity integer not null,
    new_quantity integer not null,
    reason text not null check (reason in ('manual_count','delivery')),
    incoming_stock_id uuid references public.incoming_stock(id),
    actor_id uuid references auth.users(id) on delete set null,
    created_at timestamptz not null default now()
);

alter table public.stock_items enable row level security;
alter table public.stock_locations enable row level security;
alter table public.stock_levels enable row level security;
alter table public.incoming_stock enable row level security;
alter table public.stock_events enable row level security;

revoke all on public.stock_items, public.stock_locations, public.stock_levels,
    public.incoming_stock, public.stock_events from public, anon, authenticated;
grant select on public.stock_items, public.stock_locations, public.stock_levels,
    public.incoming_stock, public.stock_events to authenticated;
grant all on public.stock_items, public.stock_locations, public.stock_levels,
    public.incoming_stock, public.stock_events to service_role;

-- Samma RLS-regel för samtliga tabeller: endast aktiv personal får läsa.
create policy "staff_read_stock_items" on public.stock_items for select to authenticated
using (exists (select 1 from public.staff_members s where s.user_id = (select auth.uid()) and s.active));
create policy "staff_read_stock_locations" on public.stock_locations for select to authenticated
using (exists (select 1 from public.staff_members s where s.user_id = (select auth.uid()) and s.active));
create policy "staff_read_stock_levels" on public.stock_levels for select to authenticated
using (exists (select 1 from public.staff_members s where s.user_id = (select auth.uid()) and s.active));
create policy "staff_read_incoming_stock" on public.incoming_stock for select to authenticated
using (exists (select 1 from public.staff_members s where s.user_id = (select auth.uid()) and s.active));
create policy "staff_read_stock_events" on public.stock_events for select to authenticated
using (exists (select 1 from public.staff_members s where s.user_id = (select auth.uid()) and s.active));

-- Gemensam, privat kontroll för alla skrivfunktioner.
create function public.assert_stock_staff()
returns void language plpgsql security definer set search_path = ''
as $$
begin
    if auth.uid() is null or not exists (
        select 1 from public.staff_members s
        where s.user_id = auth.uid() and s.active = true
    ) then
        raise exception 'Saknar personalbehörighet' using errcode = '42501';
    end if;
end;
$$;

create function public.add_stock_item(p_name text, p_sku text default null, p_unit text default 'st')
returns uuid language plpgsql security definer set search_path = ''
as $$
declare v_id uuid;
begin
    perform public.assert_stock_staff();
    if length(trim(coalesce(p_name,''))) not between 1 and 120 or
       length(trim(coalesce(p_unit,''))) not between 1 and 24 or
       length(coalesce(p_sku,'')) > 100 then
        raise exception 'Ogiltiga artikeluppgifter' using errcode = '22023';
    end if;
    insert into public.stock_items(name,sku,unit)
    values(trim(p_name),nullif(trim(p_sku),''),trim(p_unit))
    returning id into v_id;
    return v_id;
end;
$$;

create function public.add_stock_location(p_name text, p_description text default null)
returns uuid language plpgsql security definer set search_path = ''
as $$
declare v_id uuid;
begin
    perform public.assert_stock_staff();
    if length(trim(coalesce(p_name,''))) not between 1 and 100 or
       length(coalesce(p_description,'')) > 500 then
        raise exception 'Ogiltig lagerplats' using errcode = '22023';
    end if;
    insert into public.stock_locations(name,description)
    values(trim(p_name),nullif(trim(p_description),''))
    returning id into v_id;
    return v_id;
end;
$$;

-- Inventera ett antal på en specifik plats; ändringen loggas.
create function public.set_stock_level(p_item_id uuid, p_location_id uuid, p_quantity integer)
returns void language plpgsql security definer set search_path = ''
as $$
declare v_old integer;
begin
    perform public.assert_stock_staff();
    if p_quantity is null or p_quantity < 0 or p_quantity > 1000000 then
        raise exception 'Antal måste vara mellan 0 och 1000000' using errcode = '22023';
    end if;

    -- Serialisera samtidiga inventeringar av samma artikel och plats.
    perform pg_advisory_xact_lock(hashtextextended(p_item_id::text || ':' || p_location_id::text, 0));
    select quantity into v_old from public.stock_levels
    where item_id = p_item_id and location_id = p_location_id;

    insert into public.stock_levels(item_id,location_id,quantity)
    values(p_item_id,p_location_id,p_quantity)
    on conflict (item_id,location_id) do update
    set quantity = excluded.quantity, updated_at = now();

    if v_old is distinct from p_quantity then
        insert into public.stock_events(item_id,location_id,previous_quantity,new_quantity,reason,actor_id)
        values(p_item_id,p_location_id,coalesce(v_old,0),p_quantity,'manual_count',auth.uid());
    end if;
end;
$$;

create function public.add_incoming_stock(
    p_item_id uuid, p_location_id uuid, p_quantity integer,
    p_supplier text default null, p_expected_on date default null, p_notes text default null,
    p_total_cost_ore bigint default null
)
returns uuid language plpgsql security definer set search_path = ''
as $$
declare v_id uuid;
begin
    perform public.assert_stock_staff();
    if p_quantity is null or p_quantity < 1 or p_quantity > 1000000 or
       length(coalesce(p_supplier,'')) > 150 or length(coalesce(p_notes,'')) > 1000 or
       (p_total_cost_ore is not null and (p_total_cost_ore < 0 or p_total_cost_ore > 100000000000)) then
        raise exception 'Ogiltig planerad leverans' using errcode = '22023';
    end if;
    insert into public.incoming_stock(item_id,location_id,quantity,supplier,expected_on,notes,total_cost_ore,created_by)
    values(p_item_id,p_location_id,p_quantity,nullif(trim(p_supplier),''),p_expected_on,
        nullif(trim(p_notes),''),p_total_cost_ore,auth.uid())
    returning id into v_id;
    return v_id;
end;
$$;

-- Markera som mottagen högst en gång; öka saldo i SAMMA transaktion.
create function public.receive_incoming_stock(p_incoming_id uuid)
returns void language plpgsql security definer set search_path = ''
as $$
declare
    v_delivery public.incoming_stock%rowtype;
    v_old integer;
    v_new integer;
begin
    perform public.assert_stock_staff();
    select * into v_delivery from public.incoming_stock where id = p_incoming_id for update;
    if not found then
        raise exception 'Leveransen hittades inte' using errcode = 'P0002';
    end if;
    if v_delivery.status <> 'planned' then
        raise exception 'Leveransen är redan mottagen' using errcode = '22023';
    end if;

    perform pg_advisory_xact_lock(hashtextextended(
        v_delivery.item_id::text || ':' || v_delivery.location_id::text, 0));
    select quantity into v_old from public.stock_levels
    where item_id = v_delivery.item_id and location_id = v_delivery.location_id;
    v_new := coalesce(v_old,0) + v_delivery.quantity;
    if v_new > 1000000 then
        raise exception 'Lagervärdet blir för högt' using errcode = '22023';
    end if;

    insert into public.stock_levels(item_id,location_id,quantity)
    values(v_delivery.item_id,v_delivery.location_id,v_new)
    on conflict(item_id,location_id) do update
    set quantity = excluded.quantity, updated_at = now();

    update public.incoming_stock
    set status = 'received',received_at = now()
    where id = p_incoming_id;

    insert into public.stock_events(item_id,location_id,previous_quantity,new_quantity,
        reason,incoming_stock_id,actor_id)
    values(v_delivery.item_id,v_delivery.location_id,coalesce(v_old,0),v_new,
        'delivery',p_incoming_id,auth.uid());
end;
$$;

-- Hindra klienter från att köra hjälpfunktionen direkt.
revoke all on function public.assert_stock_staff() from public, anon, authenticated;
revoke all on function public.add_stock_item(text,text,text) from public, anon;
revoke all on function public.add_stock_location(text,text) from public, anon;
revoke all on function public.set_stock_level(uuid,uuid,integer) from public, anon;
revoke all on function public.add_incoming_stock(uuid,uuid,integer,text,date,text,bigint) from public, anon;
revoke all on function public.receive_incoming_stock(uuid) from public, anon;
grant execute on function public.add_stock_item(text,text,text),
    public.add_stock_location(text,text),
    public.set_stock_level(uuid,uuid,integer),
    public.add_incoming_stock(uuid,uuid,integer,text,date,text,bigint),
    public.receive_incoming_stock(uuid) to authenticated;
commit;

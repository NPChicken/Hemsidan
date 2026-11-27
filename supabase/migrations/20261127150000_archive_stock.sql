-- SpinRoll UF: dölj inaktiva artiklar och lagerplatser utan att förlora historik.
-- Kör en gång efter 20261127120000_stock_management.sql.
begin;

alter table public.stock_items add column archived_at timestamptz;
alter table public.stock_locations add column archived_at timestamptz;

-- Dessa funktioner ger en arkivering i stället för en destruktiv DELETE.
-- Arkivering är bara tillåten när saldot är noll och ingen planerad leverans finns.
create function public.archive_stock_item(p_item_id uuid)
returns void language plpgsql security definer set search_path = ''
as $$
begin
    perform public.assert_stock_staff();
    perform 1 from public.stock_items where id = p_item_id and archived_at is null for update;
    if not found then
        raise exception 'Artikeln saknas eller är redan borttagen' using errcode = 'P0002';
    end if;
    if exists (select 1 from public.stock_levels where item_id = p_item_id and quantity > 0) then
        raise exception 'Artikeln har saldo kvar. Inventera ner till 0 först.' using errcode = '23514';
    end if;
    if exists (select 1 from public.incoming_stock where item_id = p_item_id and status = 'planned') then
        raise exception 'Artikeln har kommande leveranser och kan inte tas bort.' using errcode = '23514';
    end if;
    update public.stock_items set archived_at = now() where id = p_item_id;
end;
$$;

create function public.archive_stock_location(p_location_id uuid)
returns void language plpgsql security definer set search_path = ''
as $$
begin
    perform public.assert_stock_staff();
    perform 1 from public.stock_locations where id = p_location_id and archived_at is null for update;
    if not found then
        raise exception 'Lagerplatsen saknas eller är redan borttagen' using errcode = 'P0002';
    end if;
    if exists (select 1 from public.stock_levels where location_id = p_location_id and quantity > 0) then
        raise exception 'Lagerplatsen har saldo kvar. Inventera eller flytta lagret först.' using errcode = '23514';
    end if;
    if exists (select 1 from public.incoming_stock where location_id = p_location_id and status = 'planned') then
        raise exception 'Lagerplatsen har kommande leveranser och kan inte tas bort.' using errcode = '23514';
    end if;
    update public.stock_locations set archived_at = now() where id = p_location_id;
end;
$$;

-- Förhindra nya saldon på borttagna artiklar/platser.
-- Uppdatera tidigare funktion för att kontrollera aktiv status med radlås.
create or replace function public.set_stock_level(p_item_id uuid, p_location_id uuid, p_quantity integer)
returns void language plpgsql security definer set search_path = ''
as $$
declare v_old integer;
begin
    perform public.assert_stock_staff();
    if p_quantity is null or p_quantity < 0 or p_quantity > 1000000 then
        raise exception 'Antal måste vara mellan 0 och 1000000' using errcode = '22023';
    end if;
    perform 1 from public.stock_items where id = p_item_id and archived_at is null for share;
    if not found then raise exception 'Artikeln finns inte längre' using errcode = '22023'; end if;
    perform 1 from public.stock_locations where id = p_location_id and archived_at is null for share;
    if not found then raise exception 'Lagerplatsen finns inte längre' using errcode = '22023'; end if;

    perform pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(p_item_id::text || ':' || p_location_id::text, 0)
    );
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

create or replace function public.add_incoming_stock(
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
    perform 1 from public.stock_items where id = p_item_id and archived_at is null for share;
    if not found then raise exception 'Artikeln finns inte längre' using errcode = '22023'; end if;
    perform 1 from public.stock_locations where id = p_location_id and archived_at is null for share;
    if not found then raise exception 'Lagerplatsen finns inte längre' using errcode = '22023'; end if;

    insert into public.incoming_stock(item_id,location_id,quantity,supplier,expected_on,notes,total_cost_ore,created_by)
    values(p_item_id,p_location_id,p_quantity,nullif(trim(p_supplier),''),p_expected_on,
        nullif(trim(p_notes),''),p_total_cost_ore,auth.uid())
    returning id into v_id;
    return v_id;
end;
$$;

create or replace function public.receive_incoming_stock(p_incoming_id uuid)
returns void language plpgsql security definer set search_path = ''
as $$
declare v_delivery public.incoming_stock%rowtype;
        v_old integer;
        v_new integer;
begin
    perform public.assert_stock_staff();
    select * into v_delivery from public.incoming_stock where id = p_incoming_id for update;
    if not found then raise exception 'Leveransen hittades inte' using errcode = 'P0002'; end if;
    if v_delivery.status <> 'planned' then
        raise exception 'Leveransen är redan mottagen' using errcode = '22023';
    end if;
    perform 1 from public.stock_items where id = v_delivery.item_id and archived_at is null for share;
    if not found then raise exception 'Artikeln är borttagen' using errcode = '22023'; end if;
    perform 1 from public.stock_locations where id = v_delivery.location_id and archived_at is null for share;
    if not found then raise exception 'Lagerplatsen är borttagen' using errcode = '22023'; end if;

    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
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
    update public.incoming_stock set status = 'received',received_at = now()
    where id = p_incoming_id;
    insert into public.stock_events(item_id,location_id,previous_quantity,new_quantity,reason,incoming_stock_id,actor_id)
    values(v_delivery.item_id,v_delivery.location_id,coalesce(v_old,0),v_new,'delivery',p_incoming_id,auth.uid());
end;
$$;

revoke all on function public.archive_stock_item(uuid) from public, anon;
revoke all on function public.archive_stock_location(uuid) from public, anon;
grant execute on function public.archive_stock_item(uuid),
    public.archive_stock_location(uuid) to authenticated;

commit;

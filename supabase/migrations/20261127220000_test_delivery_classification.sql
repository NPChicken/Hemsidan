-- Markera testleveranser uttryckligen. Befintliga leveranser är INTE test automatiskt.
-- Kör efter 20261127210000_cleanup_received_zero_stock.sql.
begin;

alter table public.incoming_stock
    add column if not exists is_test boolean not null default false;

-- Uppdatera registrerings-RPC: den gamla signaturen avregistreras så att
-- ny klient måste ange testflaggan. Servern ignorerar aldrig flaggan.
drop function if exists public.add_incoming_stock(uuid,uuid,integer,text,date,text,bigint);

create function public.add_incoming_stock(
    p_item_id uuid, p_location_id uuid, p_quantity integer,
    p_supplier text default null, p_expected_on date default null,
    p_notes text default null, p_total_cost_ore bigint default null,
    p_is_test boolean default false
)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare v_id uuid;
begin
    perform public.assert_stock_staff();
    if p_quantity is null or p_quantity < 1 or p_quantity > 1000000 or
       length(coalesce(p_supplier,'')) > 150 or length(coalesce(p_notes,'')) > 1000 or
       (p_total_cost_ore is not null and (p_total_cost_ore < 0 or p_total_cost_ore > 100000000000)) or
       p_is_test is null then
        raise exception 'Ogiltig planerad leverans' using errcode = '22023';
    end if;

    perform 1 from public.stock_items
    where id = p_item_id and archived_at is null for share;
    if not found then
        raise exception 'Artikeln finns inte längre' using errcode = '22023';
    end if;
    perform 1 from public.stock_locations
    where id = p_location_id and archived_at is null for share;
    if not found then
        raise exception 'Lagerplatsen finns inte längre' using errcode = '22023';
    end if;

    insert into public.incoming_stock(
        item_id, location_id, quantity, supplier, expected_on,
        notes, total_cost_ore, created_by, is_test
    ) values (
        p_item_id, p_location_id, p_quantity, nullif(trim(p_supplier),''),
        p_expected_on, nullif(trim(p_notes),''), p_total_cost_ore, auth.uid(), p_is_test
    ) returning id into v_id;
    return v_id;
end;
$$;

revoke all on function public.add_incoming_stock(
    uuid,uuid,integer,text,date,text,bigint,boolean
) from public, anon;
grant execute on function public.add_incoming_stock(
    uuid,uuid,integer,text,date,text,bigint,boolean
) to authenticated;

-- Förstärk rensning på serversidan: skyddar även om någon anropar RPC direkt.
create or replace function public.void_archived_received_stock(p_incoming_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
    v_delivery public.incoming_stock%rowtype;
    v_quantity integer;
begin
    perform public.assert_stock_staff();

    if not exists (
        select 1 from public.staff_members
        where user_id = auth.uid() and active = true and role = 'admin'
    ) then
        raise exception 'Endast administratörer kan rensa testleveranser'
            using errcode = '42501';
    end if;

    select * into v_delivery from public.incoming_stock
    where id = p_incoming_id for update;
    if not found then
        raise exception 'Leveransen hittades inte' using errcode = 'P0002';
    end if;
    if v_delivery.status <> 'received' then
        raise exception 'Leveransen är inte längre mottagen' using errcode = '22023';
    end if;
    if v_delivery.is_test is not true then
        raise exception 'Leveransen är inte markerad som test och kan inte rensas'
            using errcode = '42501';
    end if;

    perform pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(
            v_delivery.item_id::text || ':' || v_delivery.location_id::text, 0
        )
    );

    select quantity into v_quantity from public.stock_levels
    where item_id = v_delivery.item_id
      and location_id = v_delivery.location_id for update;

    if coalesce(v_quantity,0) <> 0 then
        raise exception 'Lagersaldot på den gamla platsen måste vara 0 för att rensa utan lagerjustering'
            using errcode = '23514';
    end if;

    update public.incoming_stock set status = 'voided'
    where id = p_incoming_id;

    insert into public.stock_delivery_void_events (
        incoming_stock_id, actor_id, reason
    ) values (
        p_incoming_id, auth.uid(),
        'Uttryckligen testmarkerad leverans rensad vid nollsaldo; ingen lagerjustering'
    );
end;
$$;

revoke all on function public.void_archived_received_stock(uuid) from public, anon;
grant execute on function public.void_archived_received_stock(uuid) to authenticated;

-- Admin kan uttryckligen klassificera äldre, felregistrerade testleveranser.
-- Sparar vem som gjorde ändringen och tillåter inte att riktiga leveranser
-- retroaktivt ändras i tysthet av vanlig personal.
create table if not exists public.stock_test_classification_events (
    id bigint generated always as identity primary key,
    incoming_stock_id uuid not null references public.incoming_stock(id),
    actor_id uuid references auth.users(id) on delete set null,
    created_at timestamptz not null default now()
);
alter table public.stock_test_classification_events enable row level security;
revoke all on public.stock_test_classification_events from public, anon, authenticated;
grant select on public.stock_test_classification_events to authenticated;
grant all on public.stock_test_classification_events to service_role;
create policy "active_staff_read_stock_test_classification_events"
on public.stock_test_classification_events for select to authenticated
using (exists (
    select 1 from public.staff_members s
    where s.user_id = (select auth.uid()) and s.active
));

create function public.mark_received_stock_as_test(p_incoming_id uuid)
returns void language plpgsql security definer set search_path = ''
as $$
declare v_delivery public.incoming_stock%rowtype;
begin
    perform public.assert_stock_staff();
    if not exists (
        select 1 from public.staff_members
        where user_id = auth.uid() and active = true and role = 'admin'
    ) then
        raise exception 'Endast administratörer kan märka om äldre leveranser'
            using errcode = '42501';
    end if;
    select * into v_delivery from public.incoming_stock
    where id = p_incoming_id for update;
    if not found then
        raise exception 'Leveransen hittades inte' using errcode = 'P0002';
    end if;
    if v_delivery.status <> 'received' or v_delivery.is_test then
        raise exception 'Endast omarkerade mottagna leveranser kan märkas om'
            using errcode = '22023';
    end if;
    update public.incoming_stock set is_test = true where id = p_incoming_id;
    insert into public.stock_test_classification_events(incoming_stock_id,actor_id)
    values (p_incoming_id,auth.uid());
end;
$$;
revoke all on function public.mark_received_stock_as_test(uuid) from public, anon;
grant execute on function public.mark_received_stock_as_test(uuid) to authenticated;

commit;

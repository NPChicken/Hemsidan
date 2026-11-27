-- SpinRoll UF: dölj felregistrerade mottagningar på redan arkiverade lagerplatser.
-- Ingen lagerjustering utförs. Använd för testposter som redan har inventerats bort.
-- Kör efter 20261127190000_reverse_received_stock.sql.
begin;

alter table public.incoming_stock
    drop constraint if exists incoming_stock_status_check;
alter table public.incoming_stock
    add constraint incoming_stock_status_check
    check (status in ('planned', 'received', 'reversed', 'voided'));

-- Separat revision för bortplockade testposter utan lagerpåverkan.
create table if not exists public.stock_delivery_void_events (
    id bigint generated always as identity primary key,
    incoming_stock_id uuid not null unique references public.incoming_stock(id),
    actor_id uuid references auth.users(id) on delete set null,
    reason text not null,
    created_at timestamptz not null default now()
);
alter table public.stock_delivery_void_events enable row level security;
revoke all on public.stock_delivery_void_events from public, anon, authenticated;
grant select on public.stock_delivery_void_events to authenticated;
grant all on public.stock_delivery_void_events to service_role;

create policy "active_staff_read_stock_delivery_void_events"
on public.stock_delivery_void_events for select to authenticated
using (exists (
    select 1 from public.staff_members s
    where s.user_id = (select auth.uid()) and s.active
));

create function public.void_archived_received_stock(p_incoming_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_delivery public.incoming_stock%rowtype;
    v_stock integer;
begin
    perform public.assert_stock_staff();

    select * into v_delivery from public.incoming_stock
    where id = p_incoming_id for update;
    if not found then
        raise exception 'Leveransen hittades inte' using errcode = 'P0002';
    end if;
    if v_delivery.status <> 'received' then
        raise exception 'Endast mottagna leveranser kan rensas' using errcode = '22023';
    end if;

    -- Bevarar säkerheten vid parallella lageruppdateringar.
    perform pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(
            v_delivery.item_id::text || ':' || v_delivery.location_id::text, 0
        )
    );

    -- Endast när ursprunglig lagerplats redan arkiverats.
    perform 1 from public.stock_locations
    where id = v_delivery.location_id and archived_at is not null for share;
    if not found then
        raise exception 'Lagerplatsen måste vara arkiverad för att rensa en leverans utan lagerjustering'
            using errcode = '23514';
    end if;

    select quantity into v_stock from public.stock_levels
    where item_id = v_delivery.item_id and location_id = v_delivery.location_id
    for update;
    if coalesce(v_stock, 0) <> 0 then
        raise exception 'Lagersaldot på den arkiverade platsen måste vara 0'
            using errcode = '23514';
    end if;

    update public.incoming_stock
    set status = 'voided'
    where id = p_incoming_id;

    insert into public.stock_delivery_void_events (
        incoming_stock_id,actor_id,reason
    ) values (
        p_incoming_id,auth.uid(),
        'Felaktig/testmottagning rensad efter arkivering av lagerplats; saldo ändrades inte'
    );
end;
$$;

revoke all on function public.void_archived_received_stock(uuid)
    from public, anon;
grant execute on function public.void_archived_received_stock(uuid)
    to authenticated;

commit;

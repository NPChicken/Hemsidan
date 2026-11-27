-- Rensning av felaktiga/testmottagningar efter att lager har inventerats till noll.
-- Kräver föregående migration 20261127200000_void_archived_received_stock.sql.
-- Ingen lagerplats behöver längre vara aktiv eller kunna hittas i webbgränssnittet.
-- Rensning gör INGEN lagerjustering. Endast aktiv personal med adminroll får rensa.
begin;

create or replace function public.void_archived_received_stock(p_incoming_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
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

    select * into v_delivery
    from public.incoming_stock
    where id = p_incoming_id
    for update;
    if not found then
        raise exception 'Leveransen hittades inte' using errcode = 'P0002';
    end if;
    if v_delivery.status <> 'received' then
        raise exception 'Leveransen är inte längre mottagen' using errcode = '22023';
    end if;

    -- Serialisera med inventering och inleveranser oavsett om platsen arkiverats.
    perform pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(
            v_delivery.item_id::text || ':' || v_delivery.location_id::text, 0
        )
    );

    select quantity into v_quantity
    from public.stock_levels
    where item_id = v_delivery.item_id
      and location_id = v_delivery.location_id
    for update;

    -- Om något lager finns kvar måste normal ångring användas i stället.
    if coalesce(v_quantity, 0) <> 0 then
        raise exception 'Lagersaldot för artikeln på den gamla platsen måste vara 0 för att rensa utan lagerjustering'
            using errcode = '23514';
    end if;

    update public.incoming_stock
    set status = 'voided'
    where id = p_incoming_id;

    insert into public.stock_delivery_void_events(
        incoming_stock_id, actor_id, reason
    ) values (
        p_incoming_id, auth.uid(),
        'Testmottagning rensad efter att lagersaldo kontrollerats vara 0; ingen lagerjustering'
    );
end;
$$;

revoke all on function public.void_archived_received_stock(uuid) from public, anon;
grant execute on function public.void_archived_received_stock(uuid) to authenticated;

commit;

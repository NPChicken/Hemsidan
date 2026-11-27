-- SpinRoll UF: ångra en felaktigt registrerad mottagen leverans.
-- Detta ändrar lagersaldo och bevarar historiken. Ingen rad tas bort permanent.
-- Kör efter 20261127120000_stock_management.sql.
begin;

-- Ersätt den ursprungliga statusbegränsningen med en status för ångrade mottagningar.
alter table public.incoming_stock
    drop constraint if exists incoming_stock_status_check;
alter table public.incoming_stock
    add constraint incoming_stock_status_check
    check (status in ('planned', 'received', 'reversed'));

-- Logga återföringen utan att radera tidigare händelser.
alter table public.stock_events
    drop constraint if exists stock_events_reason_check;
alter table public.stock_events
    add constraint stock_events_reason_check
    check (reason in ('manual_count', 'delivery', 'delivery_reversal'));

create function public.reverse_received_stock(p_incoming_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_delivery public.incoming_stock%rowtype;
    v_old integer;
begin
    perform public.assert_stock_staff();

    select * into v_delivery
    from public.incoming_stock
    where id = p_incoming_id
    for update;

    if not found then
        raise exception 'Leveransen finns inte' using errcode = 'P0002';
    end if;

    if v_delivery.status <> 'received' then
        raise exception 'Endast mottagna leveranser kan ångras, och bara en gång'
            using errcode = '22023';
    end if;

    -- Samma lås som vid inventering och mottagning.
    perform pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(
            v_delivery.item_id::text || ':' || v_delivery.location_id::text, 0
        )
    );

    select quantity into v_old
    from public.stock_levels
    where item_id = v_delivery.item_id
      and location_id = v_delivery.location_id
    for update;

    -- Vägra om varor redan har förbrukats eller saldot korrigerats till för lågt.
    if v_old is null or v_old < v_delivery.quantity then
        raise exception
            'Kan inte ångra leveransen: tillgängligt lagersaldo är lägre än leveransens antal. Inventera eller justera lagret först.'
            using errcode = '23514';
    end if;

    update public.stock_levels
    set quantity = v_old - v_delivery.quantity, updated_at = now()
    where item_id = v_delivery.item_id
      and location_id = v_delivery.location_id;

    update public.incoming_stock
    set status = 'reversed'
    where id = p_incoming_id;

    insert into public.stock_events(
        item_id,location_id,previous_quantity,new_quantity,reason,incoming_stock_id,actor_id
    ) values (
        v_delivery.item_id,v_delivery.location_id,v_old,
        v_old - v_delivery.quantity,'delivery_reversal',v_delivery.id,auth.uid()
    );
end;
$$;

revoke all on function public.reverse_received_stock(uuid) from public, anon;
grant execute on function public.reverse_received_stock(uuid) to authenticated;

commit;

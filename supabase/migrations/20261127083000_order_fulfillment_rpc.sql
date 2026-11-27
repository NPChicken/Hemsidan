-- SpinRoll UF – säker uppdatering av leveransstatus, endast TEST-ordrar.
-- Kör i Supabase SQL Editor efter grundmigrationen.
-- Tillåter aktiv personal att ändra leveransstatus utan att öppna tabellens UPDATE-rättigheter.
begin;

create or replace function public.set_order_fulfillment_status(
    p_order_id uuid,
    p_new_status text,
    p_expected_status text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_status text;
begin
    if auth.uid() is null or not exists (
        select 1
        from public.staff_members as sm
        where sm.user_id = auth.uid() and sm.active = true
    ) then
        raise exception 'Ingen personalbehörighet' using errcode = '42501';
    end if;

    if p_new_status is null or p_new_status not in ('new', 'packing', 'shipped') then
        raise exception 'Ogiltig orderstatus' using errcode = '22023';
    end if;

    if p_expected_status is null or p_expected_status not in ('new', 'packing', 'shipped') then
        raise exception 'Ogiltig tidigare orderstatus' using errcode = '22023';
    end if;

    update public.orders
       set fulfillment_status = p_new_status,
           updated_at = now()
     where id = p_order_id
       and fulfillment_status = p_expected_status
       and stripe_mode = 'test'
       and payment_status = 'paid'
    returning fulfillment_status into v_status;

    if v_status is null then
        raise exception 'Ordern kan inte uppdateras. Ladda om listan och försök igen.'
            using errcode = 'P0002';
    end if;

    return v_status;
end;
$$;

-- PostgreSQL ger annars nya funktioner EXECUTE till PUBLIC som standard.
revoke all on function public.set_order_fulfillment_status(uuid, text, text)
    from public, anon;
grant execute on function public.set_order_fulfillment_status(uuid, text, text)
    to authenticated;

commit;

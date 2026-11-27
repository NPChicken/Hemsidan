// SpinRoll UF — Stripe Embedded Checkout (TEST) med atomisk lagerreservation.
// Secrets i Cloudflare: STRIPE_SECRET_KEY (sk_test_...) och SUPABASE_SERVICE_ROLE_KEY.
// De får aldrig sparas i GitHub, HTML eller webbläsaren.
const SUPABASE_URL = "https://bevemgjmcdkcbtsxezsa.supabase.co";
const SUPABASE_PUBLIC_KEY = "sb_publishable_oOX7KHJwEIGkdiy9ZwMsgw_UlMpW6fA";
const ALLOWED_ORIGINS = new Set(["https://spinroll.se", "https://www.spinroll.se"]);

async function supabaseRpc(name, params, key) {
    const response = await fetch(SUPABASE_URL + "/rest/v1/rpc/" + name, {
        method: "POST",
        headers: {
            apikey: key,
            Authorization: "Bearer " + key,
            "Content-Type": "application/json",
            Accept: "application/json"
        },
        body: JSON.stringify(params),
        cache: "no-store"
    });
    const body = await response.text();
    if (!response.ok) {
        console.error("Supabase RPC " + name + " failed with HTTP " + response.status);
        const data = (() => { try { return JSON.parse(body); } catch { return {}; } })();
        throw new Error(data.message || "Lagerdatabasen kunde inte nås");
    }
    return body ? JSON.parse(body) : null;
}

async function fetchPrices() {
    const response = await fetch(SUPABASE_URL + "/rest/v1/rpc/public_catalog_prices", {
        headers: { apikey: SUPABASE_PUBLIC_KEY, Accept: "application/json" },
        cache: "no-store"
    });
    if (!response.ok) throw new Error("Produktpris kunde inte hämtas");
    const rows = await response.json();
    if (!Array.isArray(rows)) throw new Error("Prislista är ogiltig");
    return new Map(rows.map(row => [row.storefront_key, row]));
}

export default {
    async fetch(request, env) {
        const origin = request.headers.get("Origin");
        const allowed = ALLOWED_ORIGINS.has(origin);
        const headers = {
            "Access-Control-Allow-Origin": allowed ? origin : "https://spinroll.se",
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
            "Vary": "Origin",
            "Cache-Control": "no-store"
        };
        if (!allowed) return Response.json({ error: "Otillåtet ursprung" }, { status: 403, headers });
        if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
        if (request.method !== "POST") {
            return Response.json({ error: "Endast POST stöds" }, { status: 405, headers });
        }

        let reservationId = null;
        let stripeSessionId = null;
        try {
            const { items } = await request.json();
            if (!Array.isArray(items) || items.length !== 1 || items[0]?.id !== "exile" ||
                !Number.isInteger(items[0].quantity) ||
                items[0].quantity < 1 || items[0].quantity > 10) {
                return Response.json({ error: "Ogiltigt antal i kundvagnen" }, { status: 400, headers });
            }
            if (!env.STRIPE_SECRET_KEY?.startsWith("sk_test_") ||
                !env.SUPABASE_SERVICE_ROLE_KEY) {
                throw new Error("Kassans hemligheter är inte konfigurerade");
            }
            const quantity = items[0].quantity;
            const prices = await fetchPrices();
            const product = prices.get("website");
            if (!product || !Number.isSafeInteger(product.effective_price_ore) ||
                product.effective_price_ore < 100 || product.effective_price_ore > 100000000 ||
                typeof product.name !== "string" || !product.name.trim()) {
                throw new Error("Produktpriset saknas");
            }

            // Databasen låser och drar från tillgängligt lager i en transaktion.
            // Kan inte översälja om två kunder försöker köpa sista exemplaret samtidigt.
            reservationId = await supabaseRpc("reserve_storefront_stock", {
                p_storefront_key: "website",
                p_quantity: quantity
            }, env.SUPABASE_SERVICE_ROLE_KEY);
            if (typeof reservationId !== "string") throw new Error("Lagerreservation saknar ID");

            const params = new URLSearchParams();
            params.set("mode", "payment");
            params.set("ui_mode", "embedded_page");
            params.set("return_url", "https://spinroll.se/order-bekraftelse.html?session_id={CHECKOUT_SESSION_ID}");
            params.set("line_items[0][price_data][currency]", "sek");
            params.set("line_items[0][price_data][unit_amount]", String(product.effective_price_ore));
            params.set("line_items[0][price_data][product_data][name]", product.name);
            params.set("line_items[0][quantity]", String(quantity));
            params.set("metadata[stock_reservation_id]", reservationId);
            params.set("metadata[storefront_key]", "website");
            params.set("shipping_address_collection[allowed_countries][0]", "SE");
            params.set("automatic_tax[enabled]", "false");
            // Stripe kräver minst 30 min. Ingen automatisk lageråterföring baserad
            // enbart på tid: endast signerad Stripe checkout.session.expired-event.
            params.set("expires_at", String(Math.floor(Date.now() / 1000) + 30 * 60));
            params.set("payment_method_types[0]", "card");

            const stripeResponse = await fetch("https://api.stripe.com/v1/checkout/sessions", {
                method: "POST",
                headers: {
                    Authorization: "Bearer " + env.STRIPE_SECRET_KEY,
                    "Content-Type": "application/x-www-form-urlencoded"
                },
                body: params.toString()
            });
            const session = await stripeResponse.json();
            if (!stripeResponse.ok || !session.id || !session.client_secret) {
                throw new Error("Stripe Checkout Session kunde inte skapas");
            }
            stripeSessionId = session.id;
            // Bind reservation -> faktisk Stripe session. Om bindning misslyckas,
            // stoppa Stripe-sessionen innan lagret får frigöras.
            try {
                await supabaseRpc("bind_checkout_stock_reservation", {
                    p_reservation_id: reservationId,
                    p_stripe_session_id: stripeSessionId
                }, env.SUPABASE_SERVICE_ROLE_KEY);
            } catch (error) {
                const expire = await fetch(
                    "https://api.stripe.com/v1/checkout/sessions/" +
                    encodeURIComponent(stripeSessionId) + "/expire", {
                        method: "POST",
                        headers: { Authorization: "Bearer " + env.STRIPE_SECRET_KEY }
                    });
                if (expire.ok) {
                    // Stripe-sessionen är ogiltig: inga pengar kan tas emot.
                    await supabaseRpc("release_checkout_stock_reservation", {
                        p_reservation_id: reservationId
                    }, env.SUPABASE_SERVICE_ROLE_KEY);
                } else {
                    console.error("Could not expire orphan Stripe session; reservation held");
                    // Behåll reservationen hellre än att riskera översäljning.
                    reservationId = null;
                }
                throw error;
            }
            return Response.json({ clientSecret: session.client_secret }, { headers });
        } catch (error) {
            console.error("Checkout creation failed:", error.message);
            // Endast reservationer UTAN aktiv Stripe-session kan frigöras direkt.
            if (reservationId && !stripeSessionId) {
                try {
                    await supabaseRpc("release_checkout_stock_reservation", {
                        p_reservation_id: reservationId
                    }, env.SUPABASE_SERVICE_ROLE_KEY);
                } catch (releaseError) {
                    console.error("Could not release failed checkout reservation:", releaseError.message);
                }
            }
            return Response.json({
                error: /tillräckligt många exemplar/i.test(error.message)
                    ? "Det finns inte tillräckligt många exemplar i lager. Minska antalet i kundvagnen."
                    : "Kassan kunde inte skapas just nu. Försök igen senare."
            }, { status: 400, headers });
        }
    }
};

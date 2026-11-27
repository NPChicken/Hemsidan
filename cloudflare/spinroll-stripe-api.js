// SpinRoll UF — Cloudflare Worker: Stripe Embedded Checkout (TEST).
// Behåll STRIPE_SECRET_KEY som en Cloudflare Worker secret, aldrig i GitHub.
// Pris hämtas från Supabase på serversidan inför VARJE ny Checkout Session.
const SUPABASE_URL = "https://bevemgjmcdkcbtsxezsa.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_oOX7KHJwEIGkdiy9ZwMsgw_UlMpW6fA";
const ALLOWED_ORIGINS = new Set(["https://spinroll.se", "https://www.spinroll.se"]);
const PRODUCT_IDS = new Set(["exile"]); // Tillåt bara produkter som ni faktiskt säljer.

async function fetchPrices() {
    const response = await fetch(SUPABASE_URL + "/rest/v1/rpc/public_catalog_prices", {
        method: "GET",
        headers: { apikey: SUPABASE_PUBLISHABLE_KEY, Accept: "application/json" },
        cache: "no-store"
    });
    if (!response.ok) throw new Error("Supabase price API returned HTTP " + response.status);
    const rows = await response.json();
    if (!Array.isArray(rows)) throw new Error("Price API returned invalid data");
    return new Map(rows.map(row => [row.storefront_key, row]));
}

export default {
    async fetch(request, env) {
        const origin = request.headers.get("Origin");
        const allowed = ALLOWED_ORIGINS.has(origin);
        const corsHeaders = {
            "Access-Control-Allow-Origin": allowed ? origin : "https://spinroll.se",
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
            "Vary": "Origin",
            "Cache-Control": "no-store"
        };

        // Avvisa icke-godkända ursprung även för OPTIONS.
        if (!allowed) {
            return Response.json({ error: "Otillåten förfrågan" },
                { status: 403, headers: corsHeaders });
        }
        if (request.method === "OPTIONS") {
            return new Response(null, { status: 204, headers: corsHeaders });
        }
        if (request.method !== "POST") {
            return Response.json({ error: "Endast POST är tillåtet" },
                { status: 405, headers: corsHeaders });
        }

        try {
            const { items } = await request.json();
            if (!Array.isArray(items) || items.length !== 1 ||
                !items[0] || !PRODUCT_IDS.has(items[0].id)) {
                throw new Error("Ogiltig kundvagn");
            }
            const quantity = items[0].quantity;
            if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10) {
                throw new Error("Ogiltigt antal");
            }
            if (!env.STRIPE_SECRET_KEY || !env.STRIPE_SECRET_KEY.startsWith("sk_test_")) {
                throw new Error("Stripe TEST secret saknas");
            }

            const prices = await fetchPrices();
            // Produkt-ID exile i kundvagnen motsvarar hemsidans prisnyckel website.
            const product = prices.get(items[0].id === "exile" ? "website" : items[0].id);
            if (!product || !Number.isSafeInteger(product.effective_price_ore) ||
                product.effective_price_ore < 100 || product.effective_price_ore > 100000000 ||
                typeof product.name !== "string" || !product.name.trim()) {
                // Ingen fallback till 249 kr: då kan visat pris och debiterat pris skilja sig.
                throw new Error("Saknar giltigt produktpris i Supabase");
            }

            const params = new URLSearchParams();
            params.set("mode", "payment");
            params.set("ui_mode", "embedded_page");
            params.set("return_url",
                "https://spinroll.se/order-bekraftelse.html?session_id={CHECKOUT_SESSION_ID}");

            // Stripe får priset i öre från Supabase, aldrig från kunden.
            params.set("line_items[0][price_data][currency]", "sek");
            params.set("line_items[0][price_data][unit_amount]",
                String(product.effective_price_ore));
            params.set("line_items[0][price_data][product_data][name]", product.name);
            params.set("line_items[0][quantity]", String(quantity));

            params.set("shipping_address_collection[allowed_countries][0]", "SE");
            params.set("automatic_tax[enabled]", "false");

            const stripeResponse = await fetch("https://api.stripe.com/v1/checkout/sessions", {
                method: "POST",
                headers: {
                    Authorization: "Bearer " + env.STRIPE_SECRET_KEY,
                    "Content-Type": "application/x-www-form-urlencoded"
                },
                body: params.toString()
            });
            const session = await stripeResponse.json();
            if (!stripeResponse.ok || !session.client_secret) {
                console.error("Stripe session failed:", stripeResponse.status,
                    session.error?.message || "unknown");
                throw new Error("Kunde inte skapa Stripe-kassa");
            }
            return Response.json({ clientSecret: session.client_secret },
                { headers: corsHeaders });
        } catch (error) {
            console.error("Checkout error:", error.message);
            return Response.json({ error: "Kassan kunde inte skapas. Försök igen senare." },
                { status: 400, headers: corsHeaders });
        }
    }
};

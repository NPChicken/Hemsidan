// Publik prislista för SpinRoll (bara butikens priser, aldrig lager- eller personaldata).
// Endast Stripe Workern bestämmer vilket belopp som debiteras.
(() => {
    const endpoint = "https://bevemgjmcdkcbtsxezsa.supabase.co/rest/v1/rpc/public_catalog_prices";
    const apikey = "sb_publishable_oOX7KHJwEIGkdiy9ZwMsgw_UlMpW6fA";
    const priceElements = () => document.querySelectorAll("[data-storefront-price]");
    const money = ore => new Intl.NumberFormat("sv-SE", { style: "currency", currency: "SEK",
        maximumFractionDigits: 2 }).format(ore / 100);

    window.spinrollPrices = null;
    window.spinrollPricesReady = fetch(endpoint, {
        headers: { apikey, Accept: "application/json" }, cache: "no-store"
    }).then(async response => {
        if (!response.ok) throw new Error("Prislistan kunde inte hämtas");
        const rows = await response.json();
        if (!Array.isArray(rows)) throw new Error("Prislistan är ogiltig");
        const prices = Object.fromEntries(rows.filter(row =>
            typeof row.storefront_key === "string" &&
            Number.isSafeInteger(row.effective_price_ore) && row.effective_price_ore > 0
        ).map(row => [row.storefront_key, row]));
        window.spinrollPrices = prices;
        document.dispatchEvent(new CustomEvent("spinroll:prices-ready", { detail: prices }));
        return prices;
    }).catch(error => {
        window.spinrollPrices = {};
        document.dispatchEvent(new CustomEvent("spinroll:prices-error"));
        console.error("Could not load public prices", error);
        return {};
    });

    function updateProductPrices() {
        for (const node of priceElements()) {
            const product = window.spinrollPrices?.[node.dataset.storefrontPrice];
            if (!product) {
                node.textContent = "Pris ej tillgängligt";
                continue;
            }
            node.replaceChildren();
            if (product.sale_price_ore != null && product.sale_ends_at) {
                const old = document.createElement("del");
                old.textContent = money(product.regular_price_ore);
                old.className = "exile-original-price";
                node.append(old, document.createTextNode(" " + money(product.effective_price_ore)));
            } else {
                node.textContent = money(product.effective_price_ore);
            }
        }
    }

    document.addEventListener("spinroll:prices-ready", updateProductPrices);
    document.addEventListener("spinroll:prices-error", updateProductPrices);
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", () => {
            updateProductPrices();
        }, { once: true });
    } else {
        updateProductPrices();
    }
})();

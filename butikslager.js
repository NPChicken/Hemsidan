// Publik lagerstatus för aktiva butiksprodukter. Ingen intern lagerinformation.
(() => {
    const endpoint = "https://bevemgjmcdkcbtsxezsa.supabase.co/rest/v1/rpc/public_storefront_stock";
    const apikey = "sb_publishable_oOX7KHJwEIGkdiy9ZwMsgw_UlMpW6fA";
    window.spinrollStock = null;

    function renderStock() {
        document.querySelectorAll("[data-storefront-stock]").forEach(node => {
            const amount = window.spinrollStock?.[node.dataset.storefrontStock];
            node.classList.remove("stock-available", "stock-sold-out");
            if (!Number.isSafeInteger(amount)) {
                node.textContent = "Lagerstatus ej tillgänglig";
                return;
            }
            if (amount <= 0) {
                node.textContent = "Slut i lager";
                node.classList.add("stock-sold-out");
            } else {
                node.textContent = amount + " " + (amount === 1 ? "exemplar" : "exemplar") + " i lager";
                node.classList.add("stock-available");
            }
        });
        document.querySelectorAll("[data-buy-product]").forEach(button => {
            const key = button.dataset.buyProduct === "exile" ? "website" : button.dataset.buyProduct;
            const available = window.spinrollStock?.[key];
            button.disabled = !Number.isSafeInteger(available) || available <= 0;
            button.setAttribute("aria-disabled", String(button.disabled));
            if (button.dataset.originalBuyLabel === undefined) {
                button.dataset.originalBuyLabel = button.textContent.trim();
            }
            button.textContent = available === 0 ? "Slut i lager" : button.dataset.originalBuyLabel;
        });
    }

    async function refreshStorefrontStock() {
        try {
            const response = await fetch(endpoint, {
                method: "POST",
                headers: {
                    apikey,
                    "Content-Type": "application/json",
                    Accept: "application/json"
                },
                body: "{}",
                cache: "no-store"
            });
            if (!response.ok) throw new Error("Lagerstatus kunde inte hämtas");
            const rows = await response.json();
            if (!Array.isArray(rows)) throw new Error("Ogiltig lagerstatus");
            window.spinrollStock = Object.fromEntries(rows
                .filter(row => typeof row.storefront_key === "string" &&
                    Number.isSafeInteger(row.available_quantity) &&
                    row.available_quantity >= 0)
                .map(row => [row.storefront_key, row.available_quantity]));
            renderStock();
            document.dispatchEvent(new CustomEvent("spinroll:stock-ready"));
            return window.spinrollStock;
        } catch (error) {
            window.spinrollStock = null;
            renderStock();
            document.dispatchEvent(new CustomEvent("spinroll:stock-error"));
            console.error("Could not load public stock", error);
            return null;
        }
    }

    window.spinrollRefreshStock = refreshStorefrontStock;
    window.spinrollStockReady = refreshStorefrontStock();
    document.addEventListener("visibilitychange", () => {
        if (!document.hidden) void refreshStorefrontStock();
    });
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", renderStock);
    } else {
        renderStock();
    }
})();

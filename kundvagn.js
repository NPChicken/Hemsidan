
const PRODUKTER = {
    exile: {
        namn: "Exile",
        pris: null
    }
};

// Ersätt med adressen till er serverfunktion
// när den är publicerad.
const CHECKOUT_API = "";

let kundvagn = {};

try {
    kundvagn = JSON.parse(
        localStorage.getItem("spinroll-kundvagn") || "{}"
    );
} catch {
    kundvagn = {};
}

function sparaKundvagn() {
    localStorage.setItem(
        "spinroll-kundvagn",
        JSON.stringify(kundvagn)
    );

    visaKundvagn();
}

function laggIKundvagn(id) {
    if (!PRODUKTER[id]) return;
    if (!Number.isSafeInteger(window.spinrollPrices?.[id]?.effective_price_ore)) {
        alert("Priset är inte tillgängligt just nu. Försök igen senare.");
        return;
    }

    kundvagn[id] = Math.min(
        10,
        (kundvagn[id] || 0) + 1
    );

    sparaKundvagn();
    oppnaKundvagn();
}

function andraAntal(id, skillnad) {
    if (!PRODUKTER[id]) return;

    const nyttAntal = (kundvagn[id] || 0) + skillnad;

    if (nyttAntal <= 0) {
        delete kundvagn[id];
    } else {
        kundvagn[id] = Math.min(10, nyttAntal);
    }

    sparaKundvagn();
}

function oppnaKundvagn() {
    document.querySelector("#kundvagn-panel")
        .classList.add("oppen");
}

function stangKundvagn() {
    document.querySelector("#kundvagn-panel")
        .classList.remove("oppen");
}

function visaKundvagn() {
    const lista = document.querySelector("#kundvagn-lista");
    const summa = document.querySelector("#kundvagn-summa");
    const antal = document.querySelector("#kundvagn-antal");

    if (!lista) return;

    lista.innerHTML = "";

    let total = 0;
    let totaltAntal = 0;

    for (const [id, qty] of Object.entries(kundvagn)) {
        if (!PRODUKTER[id] || !Number.isInteger(qty) || qty < 1) continue;

        const produkt = PRODUKTER[id];

        const price = window.spinrollPrices?.[id];
        const unitPrice = price?.effective_price_ore;
        if (Number.isSafeInteger(unitPrice) && unitPrice > 0) total += unitPrice * qty;
        totaltAntal += qty;

        const rad = document.createElement("div");
        rad.className = "kundvagn-produkt";

        const namn = document.createElement("strong");
        namn.textContent = produkt.namn;

        const pris = document.createElement("p");
        pris.textContent = Number.isSafeInteger(unitPrice) && unitPrice > 0
            ? `${new Intl.NumberFormat("sv-SE", { style: "currency", currency: "SEK" }).format(unitPrice / 100)}/st`
            : "Pris ej tillgängligt";

        const kontroller = document.createElement("div");
        kontroller.className = "antal-kontroller";

        const minus = document.createElement("button");
        minus.textContent = "−";
        minus.addEventListener("click", () =>
            andraAntal(id, -1)
        );

        const antalText = document.createElement("span");
        antalText.textContent = qty;

        const plus = document.createElement("button");
        plus.textContent = "+";
        plus.addEventListener("click", () =>
            andraAntal(id, 1)
        );

        kontroller.append(minus, antalText, plus);
        rad.append(namn, pris, kontroller);
        lista.appendChild(rad);
    }

    if (totaltAntal === 0) {
        lista.textContent = "Din kundvagn är tom.";
    }

    const validPrices = Object.entries(kundvagn).every(([id, qty]) =>
        PRODUKTER[id] && Number.isInteger(qty) && qty > 0 &&
        Number.isSafeInteger(window.spinrollPrices?.[id]?.effective_price_ore));
    summa.textContent = validPrices ? `${new Intl.NumberFormat("sv-SE", { style: "currency", currency: "SEK" }).format(total / 100)}` : "Pris ej tillgängligt";
    const checkoutButton = document.querySelector("#till-kassan");
    if (checkoutButton) checkoutButton.disabled = !validPrices || totaltAntal === 0;
    antal.textContent = totaltAntal;
}


function tillKassan() {
    if (Object.keys(kundvagn).length === 0) {
        alert("Din kundvagn är tom.");
        return;
    }

    if (!Object.keys(kundvagn).every(id =>
        Number.isSafeInteger(window.spinrollPrices?.[id]?.effective_price_ore))) {
        alert("Priset kunde inte hämtas. Försök igen senare.");
        return;
    }
    window.location.href = "checkout.html";
}

document.addEventListener("DOMContentLoaded", () => {
    const container = document.createElement("div");

    container.innerHTML = `
        
<button id="kundvagn-knapp" type="button"
    aria-label="Öppna kundvagn">

    <svg
        xmlns="http://www.w3.org/2000/svg"
        width="25"
        height="25"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true">

        <circle cx="8" cy="21" r="1"/>
        <circle cx="19" cy="21" r="1"/>
        <path d="M2 2h2l2.4 12.4a2 2 0 0 0 2 1.6h10a2 2 0 0 0 2-1.6L22 6H5"/>

    </svg>

    <span id="kundvagn-antal">0</span>
</button>

        <aside id="kundvagn-panel" aria-label="Kundvagn">
            <div class="kundvagn-rubrik">
                <h2>Din kundvagn</h2>
                <button id="stang-kundvagn"
                    type="button" aria-label="Stäng">×</button>
            </div>

            <div id="kundvagn-lista"></div>

            <div class="kundvagn-botten">
                <p>Totalt:
                    <strong id="kundvagn-summa">0 kr</strong>
                </p>

                <button id="till-kassan" type="button">
                    Till kassan
                </button>
            </div>
        </aside>
    `;

    document.body.appendChild(container);

    document.querySelector("#kundvagn-knapp")
        .addEventListener("click", oppnaKundvagn);

    document.querySelector("#stang-kundvagn")
        .addEventListener("click", stangKundvagn);

    document.querySelector("#till-kassan")
        .addEventListener("click", tillKassan);

    visaKundvagn();
    document.addEventListener("spinroll:prices-ready", visaKundvagn);
    document.addEventListener("spinroll:prices-error", visaKundvagn);
});

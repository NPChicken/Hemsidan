
const PRODUKTER = {
    exile: {
        namn: "Exile",
        pris: 249
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

        total += produkt.pris * qty;
        totaltAntal += qty;

        const rad = document.createElement("div");
        rad.className = "kundvagn-produkt";

        const namn = document.createElement("strong");
        namn.textContent = produkt.namn;

        const pris = document.createElement("p");
        pris.textContent = `${produkt.pris} kr/st`;

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

    summa.textContent = `${total} kr`;
    antal.textContent = totaltAntal;
}


function tillKassan() {
    if (Object.keys(kundvagn).length === 0) {
        alert("Din kundvagn är tom.");
        return;
    }

    window.location.href = "checkout.html";
}

document.addEventListener("DOMContentLoaded", () => {
    const container = document.createElement("div");

    container.innerHTML = `
        <button id="kundvagn-knapp" type="button"
            aria-label="Öppna kundvagn">
            🛒 <span id="kundvagn-antal">0</span>
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
});

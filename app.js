// ============================================================
// ZBOOKS -- FASE 2 PROTOTYPE (ONLINE ONLY)
//
// No offline support yet (no manifest, no service worker, no local
// EPUB persistence) -- that is Fase 3. This phase validates the core
// idea end to end: tap a word in an EPUB, look it up against ZWords'
// dataset (fetched cross-origin from the published zwords GitHub Pages
// site), and read/write learning status in the SAME shared IndexedDB
// database ZWords itself uses (zwords_shared_db, from shared/word-
// status.js), so status set here shows up there and vice versa.
// ============================================================

const ZWORDS_BASE_URL =
    "https://andrezaferreira.github.io/zwords/";

const WORD_INDEX_URL =
    `${ZWORDS_BASE_URL}data/word_lookup_index.json`;

const IRREGULAR_VERBS_URL =
    `${ZWORDS_BASE_URL}data/04_cards_irregular_verbs.json?v=1`;


// ============================================================
// STATE
// ============================================================

let sharedWordStatusMap = {};
let wordIndex = {};
let irregularFormToBase = {};
let irregularBaseCard = {};

let book = null;
let rendition = null;

const STATUS_LABELS = {
    known: "Conhecida",
    learning: "Aprendendo",
    rare: "Palavra rara",
    seen: "Já consultada",
    none: "Sem marcação"
};


// ============================================================
// ELEMENTS
// ============================================================

const epubInput =
    document.getElementById("epubInput");

const emptyState =
    document.getElementById("emptyState");

const readerArea =
    document.getElementById("readerArea");

const viewer =
    document.getElementById("viewer");

const prevPageButton =
    document.getElementById("prevPage");

const nextPageButton =
    document.getElementById("nextPage");

const wordPanelOverlay =
    document.getElementById("wordPanelOverlay");

const wordPanelContent =
    document.getElementById("wordPanelContent");

const wordPanelClose =
    document.getElementById("wordPanelClose");

const toastElement =
    document.getElementById("toast");

const themeToggleButton =
    document.getElementById("themeToggle");

const fontSizeUpButton =
    document.getElementById("fontSizeUp");

const fontSizeDownButton =
    document.getElementById("fontSizeDown");


// ============================================================
// THEME (light/dark) -- manual override on top of prefers-color-scheme
// ============================================================

const THEME_STORAGE_KEY = "zbooks_theme";

function getEffectiveTheme() {

    const stored = localStorage.getItem(THEME_STORAGE_KEY);

    if (stored === "light" || stored === "dark") {
        return stored;
    }

    return window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";

}

function applyTheme(theme) {

    if (theme) {
        document.documentElement.dataset.theme = theme;
    } else {
        delete document.documentElement.dataset.theme;
    }

    themeToggleButton.textContent =
        getEffectiveTheme() === "dark" ? "☀️" : "🌙";

}

applyTheme(localStorage.getItem(THEME_STORAGE_KEY));

themeToggleButton.addEventListener("click", () => {

    const next =
        getEffectiveTheme() === "dark" ? "light" : "dark";

    localStorage.setItem(THEME_STORAGE_KEY, next);

    applyTheme(next);

});


// ============================================================
// READER FONT SIZE
// ============================================================

const FONT_SIZE_STORAGE_KEY = "zbooks_font_scale";
const FONT_SIZE_MIN = 70;
const FONT_SIZE_MAX = 200;
const FONT_SIZE_STEP = 10;

let readerFontScale =
    parseInt(localStorage.getItem(FONT_SIZE_STORAGE_KEY), 10) || 100;

function applyReaderFontScale() {

    if (rendition) {
        rendition.themes.fontSize(`${readerFontScale}%`);
    }

    localStorage.setItem(FONT_SIZE_STORAGE_KEY, String(readerFontScale));

}

fontSizeUpButton.addEventListener("click", () => {

    readerFontScale =
        Math.min(FONT_SIZE_MAX, readerFontScale + FONT_SIZE_STEP);

    applyReaderFontScale();

});

fontSizeDownButton.addEventListener("click", () => {

    readerFontScale =
        Math.max(FONT_SIZE_MIN, readerFontScale - FONT_SIZE_STEP);

    applyReaderFontScale();

});


// ============================================================
// SHARED WORD STATUS -- LOAD (same store ZWords reads/writes)
// ============================================================

async function initSharedWordStatus() {

    try {

        const records =
            await ZWordsSharedStatus.loadAllWordStatus();

        for (const record of records) {
            sharedWordStatusMap[record.word] = record;
        }

    } catch (error) {

        console.error(
            "Could not load shared word status:",
            error
        );

    }

}

const sharedWordStatusReady =
    initSharedWordStatus();


function getSharedRecord(word) {
    return sharedWordStatusMap[word] || null;
}


function recordWordLookup(word) {

    const record =
        sharedWordStatusMap[word] ||
        { word };

    record.lookupCount =
        (record.lookupCount || 0) + 1;

    record.lastLookupAt =
        new Date().toISOString();

    sharedWordStatusMap[word] = record;

    ZWordsSharedStatus
        .putWordStatusRecord(record)
        .catch(error => {
            console.error("Could not save word lookup:", error);
        });

}


function setExplicitStatus(word, status) {

    const record =
        sharedWordStatusMap[word] ||
        { word };

    const alreadySet =
        record.explicitStatus === status;

    if (alreadySet) {
        delete record.explicitStatus;
    } else {
        record.explicitStatus = status;
    }

    record.updatedAt =
        new Date().toISOString();

    record.updatedFrom =
        "zbooks";

    sharedWordStatusMap[word] = record;

    ZWordsSharedStatus
        .putWordStatusRecord(record)
        .catch(error => {
            console.error("Could not save word status:", error);
        });

    return alreadySet ? null : status;

}


// ============================================================
// ZWORDS DATASET -- LOAD (word lookup index + irregular verbs)
// ============================================================

async function loadLookupData() {

    const [wordIndexResponse, irregularResponse] =
        await Promise.all([
            fetch(WORD_INDEX_URL),
            fetch(IRREGULAR_VERBS_URL)
        ]);

    wordIndex = await wordIndexResponse.json();

    const irregularCards = await irregularResponse.json();

    for (const card of irregularCards) {

        const baseKey =
            ZWordsSharedStatus.normalizeSharedWord(card.base_form);

        if (!baseKey) {
            continue;
        }

        const existing = irregularBaseCard[baseKey];

        if (!existing || card.definition_number === 1) {
            irregularBaseCard[baseKey] = card;
        }

        irregularFormToBase[baseKey] = baseKey;

        for (const form of card.past_simple || []) {
            irregularFormToBase[
                ZWordsSharedStatus.normalizeSharedWord(form)
            ] = baseKey;
        }

        for (const form of card.past_participle || []) {
            irregularFormToBase[
                ZWordsSharedStatus.normalizeSharedWord(form)
            ] = baseKey;
        }

    }

}

const lookupDataReady =
    loadLookupData().catch(error => {
        console.error("Could not load ZWords lookup data:", error);
    });


// ============================================================
// WORD RESOLUTION (exact match, irregular verb form, or lemma
// candidate) -- tries hardest to land on something that exists in
// ZWords before giving up and treating the word as new.
// ============================================================

function cardToLookupResult(card, lemma, matchType, surfaceForm) {

    return {
        lemma,
        matchType,
        surfaceForm,
        word: card.word,
        pronunciation: card.pronunciation || "",
        partOfSpeech: card.part_of_speech || "",
        definition: card.definition || "",
        definitionPt: card.definition_pt || "",
        example: card.example || "",
        examplePt: card.example_pt || "",
        image: card.image || "",
        frequencyRank:
            typeof card.frequency_rank === "number"
                ? card.frequency_rank
                : null
    };

}


function resolveWord(rawWord) {

    const key =
        ZWordsSharedStatus.normalizeSharedWord(rawWord);

    if (!key) {
        return null;
    }

    if (wordIndex[key]) {
        return cardToLookupResult(
            wordIndex[key],
            key,
            "exact",
            key
        );
    }

    const irregularBase = irregularFormToBase[key];

    if (irregularBase) {

        const card =
            wordIndex[irregularBase] ||
            irregularBaseCard[irregularBase];

        if (card) {
            return cardToLookupResult(
                card,
                irregularBase,
                key === irregularBase ? "exact" : "inflected",
                key
            );
        }

    }

    const candidateLists = [
        window.ZBooksLemmaCandidates.verb(key),
        window.ZBooksLemmaCandidates.noun(key),
        window.ZBooksLemmaCandidates.adjective(key)
    ];

    for (const candidates of candidateLists) {

        for (const candidate of candidates) {

            if (wordIndex[candidate]) {
                return cardToLookupResult(
                    wordIndex[candidate],
                    candidate,
                    "inflected",
                    key
                );
            }

            const base = irregularFormToBase[candidate];

            if (base) {

                const card =
                    wordIndex[base] ||
                    irregularBaseCard[base];

                if (card) {
                    return cardToLookupResult(
                        card,
                        base,
                        "inflected",
                        key
                    );
                }

            }

        }

    }

    return null;

}


// ============================================================
// WORD PANEL -- RENDER
// ============================================================

function showWordPanel(html) {
    wordPanelContent.innerHTML = html;
    wordPanelOverlay.hidden = false;
}

function hideWordPanel() {
    wordPanelOverlay.hidden = true;
    wordPanelContent.innerHTML = "";
}

wordPanelClose.addEventListener("click", hideWordPanel);

wordPanelOverlay.addEventListener("click", event => {
    if (event.target === wordPanelOverlay) {
        hideWordPanel();
    }
});


function renderFoundWordPanel(result) {

    const record = getSharedRecord(result.lemma);

    const color =
        ZWordsSharedStatus.getDisplayColor(
            record,
            result.frequencyRank
        );

    const imageUrl =
        ZWordsSharedStatus.buildImageUrl(result.image);

    const imageHtml =
        imageUrl
            ? `<img class="wp-image" src="${imageUrl}" alt="">`
            : "";

    const surfaceNoteHtml =
        result.matchType === "inflected"
            ? `<p class="wp-surface-note">Forma de "${result.lemma}" (você tocou em "${result.surfaceForm}").</p>`
            : "";

    const learningActive =
        record && record.explicitStatus === "learning";

    const knownActive =
        record && record.explicitStatus === "known";

    showWordPanel(`
        <p class="wp-word">${result.word}</p>
        ${surfaceNoteHtml}
        <span class="wp-status-badge wp-status-${color}">
            ${STATUS_LABELS[color]}
        </span>
        ${imageHtml}
        <div class="wp-row wp-pronunciation-row">
            <span>${result.pronunciation}</span>
            <span>${result.partOfSpeech}</span>
        </div>
        <div class="wp-row">
            <span class="wp-label">Definition</span>
            ${result.definition}
        </div>
        <div class="wp-row">
            <span class="wp-label">Tradução</span>
            ${result.definitionPt}
        </div>
        <div class="wp-row">
            <span class="wp-label">Example</span>
            ${result.example}
        </div>
        <div class="wp-row">
            <span class="wp-label">Exemplo</span>
            ${result.examplePt}
        </div>
        <div class="wp-actions">
            <button
                class="wp-action-button learning ${learningActive ? "active learning" : ""}"
                data-action="learning"
            >
                ${learningActive ? "Quero aprender ✓" : "Quero aprender"}
            </button>
            <button
                class="wp-action-button known ${knownActive ? "active known" : ""}"
                data-action="known"
            >
                ${knownActive ? "Já sei ✓" : "Já sei"}
            </button>
        </div>
    `);

    wordPanelContent
        .querySelectorAll(".wp-action-button")
        .forEach(button => {
            button.addEventListener("click", () => {
                setExplicitStatus(
                    result.lemma,
                    button.dataset.action
                );
                renderFoundWordPanel(result);
            });
        });

}


async function renderNewWordPanel(rawWord) {

    const key =
        ZWordsSharedStatus.normalizeSharedWord(rawWord);

    showWordPanel(`
        <p class="wp-word">${rawWord}</p>
        <span class="wp-status-badge wp-status-none">Palavra nova</span>
        <p class="wp-new-word-note">
            Esta palavra ainda não existe no ZWords. Buscando uma
            definição rápida em inglês...
        </p>
        <div id="wpDictionaryArea"></div>
        <div class="wp-actions">
            <button class="wp-action-button" id="wpSpeakButton">
                Ouvir pronúncia
            </button>
            <button class="wp-action-button active learning" id="wpWantToLearnButton">
                Quero aprender
            </button>
        </div>
        <div id="wpPendingNote"></div>
    `);

    document
        .getElementById("wpSpeakButton")
        .addEventListener("click", () => {
            speakWord(rawWord);
        });

    document
        .getElementById("wpWantToLearnButton")
        .addEventListener("click", async () => {
            await addPendingWord(key, rawWord);
        });

    try {

        const response =
            await fetch(
                `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(key)}`
            );

        if (!response.ok) {
            throw new Error("Not found");
        }

        const entries = await response.json();
        const entry = entries[0];

        const phonetic =
            entry.phonetic ||
            (entry.phonetics || [])
                .map(item => item.text)
                .find(Boolean) ||
            "";

        const firstMeaning =
            (entry.meanings || [])[0];

        const definition =
            firstMeaning &&
            firstMeaning.definitions &&
            firstMeaning.definitions[0]
                ? firstMeaning.definitions[0].definition
                : "";

        const partOfSpeech =
            firstMeaning ? firstMeaning.partOfSpeech : "";

        const dictionaryArea =
            document.getElementById("wpDictionaryArea");

        if (dictionaryArea) {
            dictionaryArea.innerHTML = `
                <div class="wp-row wp-pronunciation-row">
                    <span>${phonetic}</span>
                    <span>${partOfSpeech}</span>
                </div>
                <div class="wp-row">
                    <span class="wp-label">Definition</span>
                    ${definition}
                </div>
            `;
        }

    } catch (error) {

        const dictionaryArea =
            document.getElementById("wpDictionaryArea");

        if (dictionaryArea) {
            dictionaryArea.innerHTML = `
                <p class="wp-new-word-note">
                    Sem definição instantânea disponível agora
                    (sem internet ou palavra não encontrada).
                    Você ainda pode marcar "Quero aprender".
                </p>
            `;
        }

    }

}


function speakWord(word) {

    if (!("speechSynthesis" in window)) {
        return;
    }

    const utterance =
        new SpeechSynthesisUtterance(word);

    utterance.lang = "en-US";

    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);

}


async function addPendingWord(key, displayWord) {

    try {

        await ZWordsSharedStatus.putPendingWord({
            word: key,
            displayWord,
            addedAt: new Date().toISOString(),
            source: "zbooks"
        });

        showToast(`"${displayWord}" adicionada à lista de aprendizado.`);

        const note = document.getElementById("wpPendingNote");

        if (note) {
            note.innerHTML =
                `<p class="wp-pending-note">Salvo -- entrará no ZWords quando o card for gerado.</p>`;
        }

    } catch (error) {

        console.error("Could not save pending word:", error);
        showToast("Não foi possível salvar agora.");

    }

}


let toastTimer = null;

function showToast(message) {

    toastElement.textContent = message;
    toastElement.hidden = false;

    clearTimeout(toastTimer);

    toastTimer = setTimeout(() => {
        toastElement.hidden = true;
    }, 2600);

}


// ============================================================
// WORD TAP DETECTION (no per-word <span> wrapping -- uses
// caretRangeFromPoint against the tapped point inside the epub.js
// content iframe, same approach as browser "select word" behavior)
// ============================================================

function getWordAtPoint(doc, x, y) {

    let range = null;

    if (doc.caretRangeFromPoint) {

        range = doc.caretRangeFromPoint(x, y);

    } else if (doc.caretPositionFromPoint) {

        const position = doc.caretPositionFromPoint(x, y);

        if (!position || !position.offsetNode) {
            return null;
        }

        range = doc.createRange();
        range.setStart(position.offsetNode, position.offset);
        range.collapse(true);

    }

    if (
        !range ||
        !range.startContainer ||
        range.startContainer.nodeType !== Node.TEXT_NODE
    ) {
        return null;
    }

    const textNode = range.startContainer;
    const text = textNode.textContent;

    const isWordChar = char => /[A-Za-z'-]/.test(char);

    let start = range.startOffset;
    let end = range.startOffset;

    while (start > 0 && isWordChar(text[start - 1])) {
        start -= 1;
    }

    while (end < text.length && isWordChar(text[end])) {
        end += 1;
    }

    const word = text.slice(start, end).trim();

    return word || null;

}


async function handleWordTap(word) {

    await Promise.all([
        sharedWordStatusReady,
        lookupDataReady
    ]);

    const result = resolveWord(word);

    if (result) {
        recordWordLookup(result.lemma);
        renderFoundWordPanel(result);
    } else {
        renderNewWordPanel(word);
    }

}


function attachWordTapListener(contents) {

    const doc = contents.document;

    doc.addEventListener("click", event => {

        const word =
            getWordAtPoint(doc, event.clientX, event.clientY);

        if (word) {
            handleWordTap(word);
        }

    });

}


// ============================================================
// EPUB LOADING
// ============================================================

epubInput.addEventListener("change", async () => {

    const file = epubInput.files[0];

    if (!file) {
        return;
    }

    const arrayBuffer = await file.arrayBuffer();

    if (rendition) {
        rendition.destroy();
    }

    book = ePub(arrayBuffer);

    rendition = book.renderTo(viewer, {
        width: "100%",
        height: "100%",
        flow: "paginated"
    });

    rendition.hooks.content.register(attachWordTapListener);

    await rendition.display();

    applyReaderFontScale();

    emptyState.hidden = true;
    readerArea.hidden = false;

});

prevPageButton.addEventListener("click", () => {
    if (rendition) {
        rendition.prev();
    }
});

nextPageButton.addEventListener("click", () => {
    if (rendition) {
        rendition.next();
    }
});

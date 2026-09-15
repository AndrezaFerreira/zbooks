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
    `${ZWORDS_BASE_URL}data/word_lookup_index.json?v=2`;

const IRREGULAR_VERBS_URL =
    `${ZWORDS_BASE_URL}data/04_cards_irregular_verbs.json?v=1`;

const AUDIO_MAP_URL =
    `${ZWORDS_BASE_URL}data/audio_map.json`;

const IRREGULAR_AUDIO_MAP_URL =
    `${ZWORDS_BASE_URL}data/irregular_forms_audio_map.json`;


// ============================================================
// STATE
// ============================================================

let sharedWordStatusMap = {};
let wordIndex = {};
let audioMap = {};
let irregularAudioMap = {};
let irregularFormToBase = {};
let irregularCardsByBase = {};

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


// ============================================================
// ZWORDS DATASET -- LOAD (word lookup index + irregular verbs)
// ============================================================

async function loadLookupData() {

    const [
        wordIndexResponse,
        irregularResponse,
        audioMapResponse,
        irregularAudioResponse
    ] =
        await Promise.all([
            fetch(WORD_INDEX_URL),
            fetch(IRREGULAR_VERBS_URL),
            fetch(AUDIO_MAP_URL),
            fetch(IRREGULAR_AUDIO_MAP_URL)
        ]);

    wordIndex = await wordIndexResponse.json();
    audioMap = await audioMapResponse.json();
    irregularAudioMap = await irregularAudioResponse.json();

    const irregularCards = await irregularResponse.json();

    for (const card of irregularCards) {

        const baseKey =
            ZWordsSharedStatus.normalizeSharedWord(card.base_form);

        if (!baseKey) {
            continue;
        }

        if (!irregularCardsByBase[baseKey]) {
            irregularCardsByBase[baseKey] = [];
        }

        irregularCardsByBase[baseKey].push(card);

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

    for (const cards of Object.values(irregularCardsByBase)) {
        cards.sort(
            (a, b) =>
                (a.definition_number || 1) - (b.definition_number || 1)
        );
    }

}

const lookupDataReady =
    loadLookupData().catch(error => {
        console.error("Could not load ZWords lookup data:", error);
    });


// ============================================================
// WORD RESOLUTION (exact match, irregular verb form, or lemma
// candidate) -- tries hardest to land on something that exists in
// ZWords before giving up and treating the word as new. Returns the
// WORD's every sense (from the words deck if it has any there, else
// from the irregular verbs deck), not just one guessed definition --
// only the reader, not the app, can tell which sense actually matches
// how the tapped word was used in that sentence.
// ============================================================

function irregularSenseToEntry(card) {

    return {
        deck: "irregulars",
        sense_id: card.sense_id || "",
        pronunciation: card.pronunciation || "",
        part_of_speech: card.part_of_speech || "",
        definition: card.definition || "",
        definition_pt: card.definition_pt || "",
        example: card.example || "",
        example_pt: card.example_pt || "",
        image: card.image || "",
        definition_number: card.definition_number || 1,
        definition_total: card.definition_total || 1
    };

}


function buildLookupResult(resolvedKey, matchType, surfaceForm) {

    const wordEntry = wordIndex[resolvedKey];
    const irregularCards = irregularCardsByBase[resolvedKey] || [];

    if (!wordEntry && irregularCards.length === 0) {
        return null;
    }

    const senses =
        (wordEntry && wordEntry.senses && wordEntry.senses.length)
            ? wordEntry.senses
            : irregularCards.map(irregularSenseToEntry);

    const displayWord =
        (wordEntry && wordEntry.word) ||
        (irregularCards[0] && irregularCards[0].word) ||
        resolvedKey;

    const frequencyRank =
        wordEntry && typeof wordEntry.frequency_rank === "number"
            ? wordEntry.frequency_rank
            : (
                irregularCards[0] &&
                typeof irregularCards[0].frequency_rank === "number"
                    ? irregularCards[0].frequency_rank
                    : null
            );

    const irregularForms =
        irregularCards.length
            ? {
                base_form: irregularCards[0].base_form || resolvedKey,
                past_simple: irregularCards[0].past_simple || [],
                past_participle: irregularCards[0].past_participle || []
            }
            : null;

    return {
        key: resolvedKey,
        matchType,
        surfaceForm,
        word: displayWord,
        frequencyRank,
        senses,
        irregularForms
    };

}


function resolveWord(rawWord) {

    const key =
        ZWordsSharedStatus.normalizeSharedWord(rawWord);

    if (!key) {
        return null;
    }

    if (wordIndex[key] || irregularCardsByBase[key]) {
        return buildLookupResult(key, "exact", key);
    }

    const irregularBase = irregularFormToBase[key];

    if (irregularBase) {
        return buildLookupResult(
            irregularBase,
            key === irregularBase ? "exact" : "inflected",
            key
        );
    }

    const candidateLists = [
        window.ZBooksLemmaCandidates.verb(key),
        window.ZBooksLemmaCandidates.noun(key),
        window.ZBooksLemmaCandidates.adjective(key)
    ];

    for (const candidates of candidateLists) {

        for (const candidate of candidates) {

            if (wordIndex[candidate] || irregularCardsByBase[candidate]) {
                return buildLookupResult(candidate, "inflected", key);
            }

            const base = irregularFormToBase[candidate];

            if (base) {
                return buildLookupResult(base, "inflected", key);
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


function getSenseColor(sense, wordRecord, frequencyRank) {

    const senseStatus =
        ZWordsSharedStatus.getSenseStatus(sense.deck, sense.sense_id);

    if (senseStatus === "known") {
        return "known";
    }

    if (senseStatus === "learning") {
        return "learning";
    }

    if (
        typeof frequencyRank === "number" &&
        frequencyRank > ZWordsSharedStatus.RARE_RANK_THRESHOLD
    ) {
        return "rare";
    }

    if (wordRecord && wordRecord.lookupCount > 0) {
        return "seen";
    }

    return "none";

}


function renderIrregularFormsHtml(irregularForms) {

    if (!irregularForms) {
        return "";
    }

    // The base form is a normal dataset word, so its audio lives in
    // audio_map.json; only the inflected past forms live in
    // irregular_forms_audio_map.json.
    const renderForm = (form, audioSource) => {

        const audioUrl =
            ZWordsSharedStatus.buildAudioUrl(audioSource[form]);

        return `
            <span class="wp-form-chip">
                ${form}
                ${
                    audioUrl
                        ? `<button class="wp-form-speak" data-audio-url="${audioUrl}">🔊</button>`
                        : ""
                }
            </span>
        `;

    };

    return `
        <div class="wp-row wp-irregular-forms">
            <span class="wp-label">Verb forms</span>
            <div class="wp-form-group">
                <span class="wp-form-group-label">Base</span>
                ${renderForm(irregularForms.base_form, audioMap)}
            </div>
            <div class="wp-form-group">
                <span class="wp-form-group-label">Past simple</span>
                ${
                    irregularForms.past_simple
                        .map(form => renderForm(form, irregularAudioMap))
                        .join("")
                }
            </div>
            <div class="wp-form-group">
                <span class="wp-form-group-label">Past participle</span>
                ${
                    irregularForms.past_participle
                        .map(form => renderForm(form, irregularAudioMap))
                        .join("")
                }
            </div>
        </div>
    `;

}


function renderSenseHtml(sense, index, wordRecord, frequencyRank) {

    const color = getSenseColor(sense, wordRecord, frequencyRank);

    const imageUrl =
        ZWordsSharedStatus.buildImageUrl(sense.image);

    const imageHtml =
        imageUrl
            ? `<img class="wp-image" src="${imageUrl}" alt="">`
            : "";

    const senseStatus =
        ZWordsSharedStatus.getSenseStatus(sense.deck, sense.sense_id);

    const learningActive = senseStatus === "learning";
    const knownActive = senseStatus === "known";

    return `
        <div class="wp-sense" data-sense-index="${index}">
            <div class="wp-sense-header">
                <span class="wp-pos-badge">${sense.part_of_speech}</span>
                <span class="wp-status-badge wp-status-${color}">
                    ${STATUS_LABELS[color]}
                </span>
                ${
                    sense.definition_total > 1
                        ? `<span class="wp-sense-count">${sense.definition_number}/${sense.definition_total}</span>`
                        : ""
                }
            </div>
            ${imageHtml}
            <div class="wp-row wp-pronunciation-row">
                <span>${sense.pronunciation}</span>
            </div>
            <div class="wp-row">
                <span class="wp-label">Definition</span>
                ${sense.definition}
            </div>
            <div class="wp-row">
                <span class="wp-label">Tradução</span>
                ${sense.definition_pt}
            </div>
            <div class="wp-row">
                <span class="wp-label">Example</span>
                ${sense.example}
            </div>
            <div class="wp-row">
                <span class="wp-label">Exemplo</span>
                ${sense.example_pt}
            </div>
            <div class="wp-actions">
                <button
                    class="wp-action-button learning ${learningActive ? "active learning" : ""}"
                    data-sense-index="${index}"
                    data-action="learning"
                >
                    ${learningActive ? "Quero aprender ✓" : "Quero aprender"}
                </button>
                <button
                    class="wp-action-button known ${knownActive ? "active known" : ""}"
                    data-sense-index="${index}"
                    data-action="known"
                >
                    ${knownActive ? "Já sei ✓" : "Já sei"}
                </button>
            </div>
        </div>
    `;

}


function renderFoundWordPanel(result) {

    const wordRecord = getSharedRecord(result.key);

    const audioUrl =
        ZWordsSharedStatus.buildAudioUrl(audioMap[result.word]);

    const surfaceNoteHtml =
        result.matchType === "inflected"
            ? `<p class="wp-surface-note">Forma de "${result.key}" (você tocou em "${result.surfaceForm}").</p>`
            : "";

    const sensesHtml =
        result.senses
            .map((sense, index) =>
                renderSenseHtml(
                    sense,
                    index,
                    wordRecord,
                    result.frequencyRank
                )
            )
            .join("");

    const multiSenseNoteHtml =
        result.senses.length > 1
            ? `<p class="wp-surface-note">Esta palavra tem ${result.senses.length} definições -- marque a que combina com a frase que você leu.</p>`
            : "";

    showWordPanel(`
        <p class="wp-word">
            ${result.word}
            ${
                audioUrl
                    ? `<button class="wp-form-speak wp-word-speak" data-audio-url="${audioUrl}">🔊</button>`
                    : ""
            }
        </p>
        ${surfaceNoteHtml}
        ${renderIrregularFormsHtml(result.irregularForms)}
        ${multiSenseNoteHtml}
        ${sensesHtml}
    `);

    wordPanelContent
        .querySelectorAll(".wp-form-speak")
        .forEach(button => {
            button.addEventListener("click", () => {
                playAudioUrl(button.dataset.audioUrl);
            });
        });

    wordPanelContent
        .querySelectorAll(".wp-action-button")
        .forEach(button => {
            button.addEventListener("click", () => {

                const sense =
                    result.senses[
                        Number(button.dataset.senseIndex)
                    ];

                const currentStatus =
                    ZWordsSharedStatus.getSenseStatus(
                        sense.deck,
                        sense.sense_id
                    );

                const nextStatus =
                    currentStatus === button.dataset.action
                        ? "new"
                        : button.dataset.action;

                ZWordsSharedStatus.setSenseStatus(
                    sense.deck,
                    sense.sense_id,
                    nextStatus
                );

                renderFoundWordPanel(result);

            });

        });

}


function playAudioUrl(url) {

    if (!url) {
        return;
    }

    const audio = new Audio(url);

    audio.play().catch(() => {});

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
        recordWordLookup(result.key);
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

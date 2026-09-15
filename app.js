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

// Keyed by the exact (trimmed, whitespace-collapsed) definition/example
// text itself, same as ZWords' own getDefinitionAudioPath/
// getExampleAudioPath -- there's no sense_id-keyed version of these.
const DEFINITION_AUDIO_MAP_URL =
    `${ZWORDS_BASE_URL}data/definition_audio_map.json`;

const EXAMPLE_AUDIO_MAP_URL =
    `${ZWORDS_BASE_URL}data/example_audio_map.json`;

// Small enough (~900KB, 1,284 senses) to fetch whole, unlike the words
// deck -- no need for a prebuilt compact index. Phrasal verbs are
// multi-word ("give up"), so they can only ever match typed search
// (resolveWord is called with whatever text was submitted, spaces and
// all), never a single tapped word.
const PHRASAL_VERBS_URL =
    `${ZWORDS_BASE_URL}data/05_cards_phrasal_verbs.json`;

// ~11MB, same reasoning as phrasal verbs (multi-word, typed-search-only)
// -- no compact index, fetched whole.
const PHRASES_URL =
    `${ZWORDS_BASE_URL}data/03_cards_phrases.json`;


// ============================================================
// STATE
// ============================================================

let sharedWordStatusMap = {};
let wordIndex = {};
let audioMap = {};
let irregularAudioMap = {};
let definitionAudioMap = {};
let exampleAudioMap = {};
let irregularFormToBase = {};
let irregularCardsByBase = {};
let irregularWordIndex = {};
let phrasalVerbIndex = {};
let phraseIndex = {};

let book = null;
let rendition = null;

// Matches ZWords' own wording (New/Learning/Known) for the shared
// states; "Rare word" is the one status ZWords itself doesn't have.
const STATUS_LABELS = {
    known: "Known",
    learning: "Learning",
    rare: "Rare word",
    none: "New"
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

const wordSearchForm =
    document.getElementById("wordSearchForm");

const wordSearchInput =
    document.getElementById("wordSearchInput");

const wordSearchSuggestions =
    document.getElementById("wordSearchSuggestions");

const tocButton =
    document.getElementById("tocButton");

const tocOverlay =
    document.getElementById("tocOverlay");

const tocPanel =
    document.getElementById("tocPanel");

const tocList =
    document.getElementById("tocList");

const tocPanelClose =
    document.getElementById("tocPanelClose");

const wordPanelOverlay =
    document.getElementById("wordPanelOverlay");

const wordPanel =
    document.getElementById("wordPanel");

const wordPanelContent =
    document.getElementById("wordPanelContent");

const wordPanelClose =
    document.getElementById("wordPanelClose");

const toastElement =
    document.getElementById("toast");

const debugLogElement =
    document.getElementById("debugLog");

// TEMPORARY: appends (never overwrites) so a whole tap's event sequence
// stays readable on screen. Remove alongside DEBUG_TAP once iOS tapping
// is confirmed working.
function logDebug(message) {

    if (!debugLogElement) {
        return;
    }

    debugLogElement.hidden = false;

    const line = document.createElement("div");
    line.textContent = `${new Date().toISOString().slice(11, 23)} ${message}`;

    debugLogElement.appendChild(line);
    debugLogElement.scrollTop = debugLogElement.scrollHeight;

}

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

// Most EPUBs don't set their own background/text color (they just
// inherit the browser default), so when the app shell goes dark the
// content iframe's own background can stay transparent while its text
// stays near-black -- dark-on-dark, unreadable. epub.js's themes API
// injects real CSS into each content iframe it renders, which is what
// actually fixes contrast (toggling only the app chrome's CSS variables
// cannot reach inside that iframe).
//
// One theme name, re-registered with different rules each time -- not
// two separate themes toggled with .select(). epub.js's addStylesheetRules
// reuses the same <style> element per theme name and only ever APPENDS
// rules to it (insertRule), it never clears old ones; two separate theme
// names each get their own <style> tag, and once both exist the one
// added later always wins the cascade regardless of which one is
// "selected" afterward -- confirmed live: dark, once toggled on, kept
// winning even after switching back to light. Reusing one name means
// there's only ever one stylesheet, and the newest rule (always
// appended last) is always the one that applies.
function applyReaderTheme() {

    if (!rendition) {
        return;
    }

    const isDark =
        getEffectiveTheme() === "dark";

    // Dark navy background with muted grayish-white text, matching a
    // reference (Zotero's PDF dark mode) -- not pure white/pure black,
    // which is harsher to read for long stretches.
    const rules =
        isDark
            ? {
                "body": {
                    "background": "#242832 !important",
                    "color": "#c9cdd6 !important"
                },
                "a": {
                    "color": "#9db4e8 !important"
                }
            }
            : {
                "body": {
                    "background": "#ffffff !important",
                    "color": "#1a1a1a !important"
                }
            };

    try {

        rendition.themes.register("zbooks-reader", rules);
        rendition.themes.select("zbooks-reader");

    } catch (error) {

        console.error("Could not apply reader theme:", error);

    }

}

function applyTheme(theme) {

    if (theme) {
        document.documentElement.dataset.theme = theme;
    } else {
        delete document.documentElement.dataset.theme;
    }

    themeToggleButton.textContent =
        getEffectiveTheme() === "dark" ? "☀️" : "🌙";

    applyReaderTheme();

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
const FONT_SIZE_MAX = 260;
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

// Shared by phrases and phrasal verbs: groups a flat cards array (the
// same shape ZWords' own data/*.json files use) into a word_lookup_
// index.json-style map, keyed by normalized phrase text, each holding
// every sense for that phrase under the given deck name.
function buildPhraseIndex(cards, deckName) {

    const index = {};

    for (const card of cards) {

        const key =
            ZWordsSharedStatus.normalizeSharedWord(card.word);

        if (!key) {
            continue;
        }

        if (!index[key]) {
            index[key] = {
                word: card.word,
                frequency_rank: card.frequency_rank,
                senses: []
            };
        }

        index[key].senses.push({
            deck: deckName,
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
        });

    }

    for (const entry of Object.values(index)) {
        entry.senses.sort(
            (a, b) => a.definition_number - b.definition_number
        );
    }

    return index;

}


async function loadLookupData() {

    const [
        wordIndexResponse,
        irregularResponse,
        audioMapResponse,
        irregularAudioResponse,
        phrasalVerbsResponse,
        phrasesResponse,
        definitionAudioResponse,
        exampleAudioResponse
    ] =
        await Promise.all([
            fetch(WORD_INDEX_URL),
            fetch(IRREGULAR_VERBS_URL),
            fetch(AUDIO_MAP_URL),
            fetch(IRREGULAR_AUDIO_MAP_URL),
            fetch(PHRASAL_VERBS_URL),
            fetch(PHRASES_URL),
            fetch(DEFINITION_AUDIO_MAP_URL),
            fetch(EXAMPLE_AUDIO_MAP_URL)
        ]);

    wordIndex = await wordIndexResponse.json();
    audioMap = await audioMapResponse.json();
    irregularAudioMap = await irregularAudioResponse.json();
    definitionAudioMap = await definitionAudioResponse.json();
    exampleAudioMap = await exampleAudioResponse.json();

    const irregularCards = await irregularResponse.json();
    const phrasalVerbCards = await phrasalVerbsResponse.json();
    const phraseCards = await phrasesResponse.json();

    phrasalVerbIndex = buildPhraseIndex(phrasalVerbCards, "phrasalVerbs");
    phraseIndex = buildPhraseIndex(phraseCards, "phrases");

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

    for (const [baseKey, cards] of Object.entries(irregularCardsByBase)) {

        cards.sort(
            (a, b) =>
                (a.definition_number || 1) - (b.definition_number || 1)
        );

        // Same {word, frequency_rank, senses} shape as the other three
        // indexes, purely so search suggestions can scan all four decks
        // uniformly instead of special-casing irregulars' own raw-card
        // array shape.
        irregularWordIndex[baseKey] = {
            word: cards[0].word,
            frequency_rank: cards[0].frequency_rank,
            senses: cards.map(irregularSenseToEntry)
        };

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


// Checks all four decks, in order: Words, Irregular Verbs (base/
// inflected form), Phrasal Verbs, Phrases -- first one with a match for
// this exact key wins. Collisions across them should be rare (they're
// mostly disjoint: single words vs multi-word phrases), so this
// ordering mainly just decides Words over Irregular Verbs for a plain
// base form that happens to exist in both.
function buildLookupResult(resolvedKey, matchType, surfaceForm) {

    const wordEntry = wordIndex[resolvedKey];
    const irregularCards = irregularCardsByBase[resolvedKey] || [];

    const source =
        (wordEntry && wordEntry.senses && wordEntry.senses.length)
            ? wordEntry
            : irregularCards.length
                ? {
                    word: irregularCards[0].word,
                    frequency_rank: irregularCards[0].frequency_rank,
                    senses: irregularCards.map(irregularSenseToEntry)
                }
                : phrasalVerbIndex[resolvedKey] || phraseIndex[resolvedKey];

    if (!source) {
        return null;
    }

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
        word: source.word || resolvedKey,
        frequencyRank:
            typeof source.frequency_rank === "number"
                ? source.frequency_rank
                : null,
        senses: source.senses,
        irregularForms
    };

}


function resolveWord(rawWord) {

    const key =
        ZWordsSharedStatus.normalizeSharedWord(rawWord);

    if (!key) {
        return null;
    }

    if (
        wordIndex[key] ||
        irregularCardsByBase[key] ||
        phrasalVerbIndex[key] ||
        phraseIndex[key]
    ) {
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
    // The browser can keep the scrollable panel's old scroll offset
    // across an innerHTML swap, opening mid-scroll instead of at the
    // top -- force it back to the top every time new content goes in.
    wordPanel.scrollTop = 0;
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

    return "none";

}


// A form chip either plays real ZWords audio (irregular forms, and the
// base form, which is a normal dataset word) or, for a form with no
// recorded audio at all (a computed regular past tense), falls back to
// speechSynthesis -- same fallback already used for brand new words.
function renderFormChip(form, audioUrl) {

    return `
        <span class="wp-form-chip">
            ${form}
            <button
                class="wp-form-speak"
                ${
                    audioUrl
                        ? `data-audio-url="${audioUrl}"`
                        : `data-speak-word="${form}"`
                }
            >🔊</button>
        </span>
    `;

}


// Regular verbs have no entry in the irregular-verbs dataset (there is
// nothing irregular to record), so their past simple/participle is
// generated with the ordinary English spelling rules -- covers the
// common cases (stop/stopped, try/tried, like/liked, walk/walked,
// open/opened). Consonant doubling only applies to a true one-syllable
// CVC word (stop, plan) -- approximated by counting vowel groups, which
// is what keeps two-syllable words like "open" or "enter" from wrongly
// doubling into "openned"/"enterred". Words like "admit"/"refer" (also
// double, but because the STRESS falls on the last syllable, which
// vowel-counting alone can't detect) are a known remaining gap.
function computeRegularPastForm(base) {

    const lower = base.toLowerCase();

    if (/[^aeiou]y$/i.test(lower)) {
        return base.slice(0, -1) + "ied";
    }

    if (/e$/i.test(lower)) {
        return base + "d";
    }

    const vowelGroups = lower.match(/[aeiou]+/g) || [];

    const isMonosyllabicCvc =
        vowelGroups.length === 1 &&
        /[^aeiouwxy][aeiou][^aeiouwxy]$/i.test(lower);

    if (isMonosyllabicCvc) {
        return base + base.slice(-1) + "ed";
    }

    return base + "ed";

}


function renderVerbFormsHtml(word, irregularForms) {

    if (irregularForms) {

        return `
            <div class="wp-row wp-irregular-forms">
                <span class="wp-label">Verb forms</span>
                <div class="wp-form-group">
                    <span class="wp-form-group-label">Base</span>
                    ${
                        renderFormChip(
                            irregularForms.base_form,
                            ZWordsSharedStatus.buildAudioUrl(
                                audioMap[irregularForms.base_form]
                            )
                        )
                    }
                </div>
                <div class="wp-form-group">
                    <span class="wp-form-group-label">Past simple</span>
                    ${
                        irregularForms.past_simple
                            .map(form =>
                                renderFormChip(
                                    form,
                                    ZWordsSharedStatus.buildAudioUrl(
                                        irregularAudioMap[form]
                                    )
                                )
                            )
                            .join("")
                    }
                </div>
                <div class="wp-form-group">
                    <span class="wp-form-group-label">Past participle</span>
                    ${
                        irregularForms.past_participle
                            .map(form =>
                                renderFormChip(
                                    form,
                                    ZWordsSharedStatus.buildAudioUrl(
                                        irregularAudioMap[form]
                                    )
                                )
                            )
                            .join("")
                    }
                </div>
            </div>
        `;

    }

    const pastForm = computeRegularPastForm(word);

    return `
        <div class="wp-row wp-irregular-forms">
            <span class="wp-label">Verb forms (regular)</span>
            <div class="wp-form-group">
                <span class="wp-form-group-label">Base</span>
                ${
                    renderFormChip(
                        word,
                        ZWordsSharedStatus.buildAudioUrl(audioMap[word])
                    )
                }
            </div>
            <div class="wp-form-group">
                <span class="wp-form-group-label">Past simple / participle</span>
                ${renderFormChip(pastForm, null)}
            </div>
        </div>
    `;

}


// Definition/example audio is keyed by the exact sentence text itself
// (trimmed, whitespace-collapsed), same as ZWords' own normalizeAudioText
// -- there's no sense_id-keyed version of these maps.
function getTextAudioUrl(map, text) {

    const normalized =
        String(text ?? "").trim().replace(/\s+/g, " ");

    if (!normalized) {
        return null;
    }

    return ZWordsSharedStatus.buildAudioUrl(map[normalized]);

}


function renderSenseHtml(sense, index, wordRecord, frequencyRank, word, irregularForms, wordAudioUrl) {

    const color = getSenseColor(sense, wordRecord, frequencyRank);

    const definitionAudioUrl =
        getTextAudioUrl(definitionAudioMap, sense.definition);

    const exampleAudioUrl =
        getTextAudioUrl(exampleAudioMap, sense.example);

    const imageUrl =
        ZWordsSharedStatus.buildImageUrl(sense.image);

    // Same badge as ZWords' own flashcards -- frequencyRank is word-
    // level (null for phrases/phrasal verbs, which don't track it), so
    // it naturally only shows for Words/Irregular Verbs senses.
    const frequencyRankBadgeHtml =
        imageUrl && Number.isInteger(frequencyRank)
            ? `
                <div
                    class="frequency-rank-badge"
                    title="Frequency rank among 34,002 words"
                    aria-label="Frequency rank ${frequencyRank.toLocaleString("en-US")}"
                >
                    #${frequencyRank.toLocaleString("en-US")}
                </div>
            `
            : "";

    const imageHtml =
        imageUrl
            ? `
                <div class="wp-image-wrap">
                    <img class="wp-image" src="${imageUrl}" alt="">
                    ${frequencyRankBadgeHtml}
                </div>
            `
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
                ${
                    wordAudioUrl
                        ? `<button class="wp-form-speak" data-audio-url="${wordAudioUrl}">🔊</button>`
                        : ""
                }
            </div>
            ${
                sense.part_of_speech.toLowerCase() === "verb"
                    ? renderVerbFormsHtml(word, irregularForms)
                    : ""
            }
            <div class="wp-row">
                <span class="wp-label">
                    Definition
                    ${
                        definitionAudioUrl
                            ? `<button class="wp-form-speak" data-audio-url="${definitionAudioUrl}">🔊</button>`
                            : ""
                    }
                </span>
                ${sense.definition}
            </div>
            <div class="wp-row">
                <span class="wp-label">Translation</span>
                ${sense.definition_pt}
            </div>
            <div class="wp-row">
                <span class="wp-label">
                    Example
                    ${
                        exampleAudioUrl
                            ? `<button class="wp-form-speak" data-audio-url="${exampleAudioUrl}">🔊</button>`
                            : ""
                    }
                </span>
                ${sense.example}
            </div>
            <div class="wp-row">
                <span class="wp-label">Example (Portuguese)</span>
                ${sense.example_pt}
            </div>
            <div class="wp-actions">
                <button
                    class="wp-action-button learning ${learningActive ? "active learning" : ""}"
                    data-sense-index="${index}"
                    data-action="learning"
                >
                    ${learningActive ? "Should Learn ✓" : "Should Learn"}
                </button>
                <button
                    class="wp-action-button known ${knownActive ? "active known" : ""}"
                    data-sense-index="${index}"
                    data-action="known"
                >
                    ${knownActive ? "Already Knew ✓" : "Already Knew"}
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
            ? `<p class="wp-surface-note">Form of "${result.key}" (you tapped "${result.surfaceForm}").</p>`
            : "";

    const sensesHtml =
        result.senses
            .map((sense, index) =>
                renderSenseHtml(
                    sense,
                    index,
                    wordRecord,
                    result.frequencyRank,
                    result.word,
                    result.irregularForms,
                    audioUrl
                )
            )
            .join("");

    const multiSenseNoteHtml =
        result.senses.length > 1
            ? `<p class="wp-surface-note">This word has ${result.senses.length} definitions -- mark the one that matches what you read.</p>`
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
        ${multiSenseNoteHtml}
        ${sensesHtml}
    `);

    wordPanelContent
        .querySelectorAll(".wp-form-speak")
        .forEach(button => {
            button.addEventListener("click", () => {

                if (button.dataset.audioUrl) {
                    playAudioUrl(button.dataset.audioUrl);
                } else if (button.dataset.speakWord) {
                    speakWord(button.dataset.speakWord);
                }

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


// A brand new word (not in ZWords) mirrors the found-word card layout
// (word, then a pronunciation row carrying the audio button) instead of
// fetching a quick definition from a third-party dictionary -- that
// instant lookup is gone; the plan going forward is a proper external
// dictionary integration, not an inline placeholder. Since the audio
// button already lives up top, the single action below is "Add to
// ZWords", which queues the word in pending_words for the ZWords
// pipeline to turn into a real card later (image, definition, example).
function renderNewWordPanel(rawWord) {

    const key =
        ZWordsSharedStatus.normalizeSharedWord(rawWord);

    showWordPanel(`
        <p class="wp-word">
            ${rawWord}
            <button class="wp-form-speak wp-word-speak" data-speak-word="${rawWord}">🔊</button>
        </p>
        <span class="wp-status-badge wp-status-none">New word</span>
        <p class="wp-new-word-note">
            This word doesn't exist in ZWords yet.
        </p>
        <div class="wp-actions">
            <button class="wp-action-button active learning" id="wpAddToZWordsButton">
                Add to ZWords
            </button>
        </div>
        <div id="wpPendingNote"></div>
    `);

    wordPanelContent
        .querySelectorAll(".wp-form-speak")
        .forEach(button => {
            button.addEventListener("click", () => {
                speakWord(button.dataset.speakWord);
            });
        });

    document
        .getElementById("wpAddToZWordsButton")
        .addEventListener("click", async () => {
            await addPendingWord(key, rawWord);
        });

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

        showToast(`"${displayWord}" added to ZWords.`);

        const note = document.getElementById("wpPendingNote");

        if (note) {
            note.innerHTML =
                `<p class="wp-pending-note">Saved -- will enter ZWords once the card is generated.</p>`;
        }

    } catch (error) {

        console.error("Could not save pending word:", error);
        showToast("Could not save right now.");

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
        if (typeof DEBUG_TAP !== "undefined" && DEBUG_TAP) {
            logDebug(
                `getWordAtPoint: no usable range (range=${!!range}, nodeType=${range && range.startContainer ? range.startContainer.nodeType : "n/a"})`
            );
        }
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


// Touch coordinate math (touchstart/touchend distance+timing) turned
// out to be a dead end on iOS: paginated flow uses epub.js's built-in
// "snap" manager, which runs a scroll-settle animation on EVERY
// touchend (even a stationary tap) that can redisplay/recreate the
// content view, and confirmed via the on-screen debug log that even
// listening at the Rendition level (rendition.on("touchend", ...),
// which should survive that recreation) never actually fired for a
// real finger tap on the device -- only "click" (desktop mouse) does.
//
// Instead of continuing to fight epub.js's internal touch handling,
// this uses the interaction every e-reader already trains people to
// use: press-and-hold (or double-tap) a word to select it, exactly
// like Kindle/Apple Books. That is the browser's OWN native text
// selection, which iOS handles natively and reliably -- epub.js
// exposes it as a "selected" event (Contents listens for
// "selectionchange" and, after a short debounce, emits the selected
// CFI); the actual selected text is read via contents.window.
// getSelection(). Desktop mouse keeps using plain "click".
// TEMPORARY: DEBUG_TAP logs which stage fires, to confirm this path
// actually works on the device before removing the logging.
const DEBUG_TAP = false;

function attachWordTapListeners(targetRendition) {

    if (DEBUG_TAP) {
        logDebug("attachWordTapListeners: wiring rendition.on(...)");
    }

    targetRendition.on("click", (event, contents) => {

        if (DEBUG_TAP) {
            logDebug("click fired");
        }

        const word =
            getWordAtPoint(contents.document, event.clientX, event.clientY);

        if (word) {
            handleWordTap(word);
        }

    });

    targetRendition.on("selected", (cfiRange, contents) => {

        const selection = contents.window.getSelection();
        const text = selection ? selection.toString().trim() : "";

        if (DEBUG_TAP) {
            logDebug(`selected: "${text}"`);
        }

        if (!text) {
            return;
        }

        const word = text.split(/\s+/)[0];

        handleWordTap(word);

        if (selection) {
            selection.removeAllRanges();
        }

    });

    // Direct fallback: listen for the native selectionchange event on
    // each content document itself, in case epub.js's own "selected"
    // proxy (Contents -> Rendition) isn't actually the thing at fault --
    // the on-screen selection clearly worked (handles + native menu
    // visible), so this checks whether the browser event reaches us at
    // all, independent of epub.js's own wiring.
    targetRendition.hooks.content.register(contents => {

        if (DEBUG_TAP) {
            logDebug("content hook: registering selectionchange");
        }

        let debounceTimer = null;

        contents.document.addEventListener("selectionchange", () => {

            if (DEBUG_TAP) {
                logDebug("selectionchange fired (direct)");
            }

            clearTimeout(debounceTimer);

            debounceTimer = setTimeout(() => {

                const selection = contents.window.getSelection();
                const text = selection ? selection.toString().trim() : "";

                if (DEBUG_TAP) {
                    logDebug(`selection settled (direct): "${text}"`);
                }

                if (!text) {
                    return;
                }

                const word = text.split(/\s+/)[0];

                handleWordTap(word);

                if (selection) {
                    selection.removeAllRanges();
                }

            }, 300);

        });

    });

}


// ============================================================
// READING POSITION (resume where you left off, per book)
//
// Keyed by the EPUB's own unique identifier (from its metadata, stable
// regardless of the local filename), falling back to name+size for a
// book that doesn't declare one. Just the current CFI in localStorage
// -- no need for the shared IndexedDB store, this is purely a per-
// device reading convenience, not data ZWords needs to see.
// ============================================================

const READING_POSITION_PREFIX = "zbooks_position_";

function getBookStorageKey(targetBook, file) {

    const identifier =
        targetBook.packaging &&
        targetBook.packaging.metadata &&
        targetBook.packaging.metadata.identifier;

    const key =
        identifier ||
        `${file.name}:${file.size}`;

    return READING_POSITION_PREFIX + key;

}

function saveReadingPosition(bookKey, cfi) {

    if (!cfi) {
        return;
    }

    try {
        localStorage.setItem(bookKey, cfi);
    } catch (error) {
        console.error("Could not save reading position:", error);
    }

}

function loadReadingPosition(bookKey) {

    try {
        return localStorage.getItem(bookKey);
    } catch (error) {
        return null;
    }

}


// ============================================================
// TABLE OF CONTENTS
// ============================================================

function escapeHtml(value) {
    return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
}

function renderTocItems(items) {

    return items
        .map(item => {

            const children =
                item.subitems && item.subitems.length
                    ? `<ul class="toc-sublist">${renderTocItems(item.subitems)}</ul>`
                    : "";

            return `
                <li class="toc-item">
                    <button class="toc-link" data-href="${escapeHtml(item.href)}">
                        ${escapeHtml((item.label || "").trim())}
                    </button>
                    ${children}
                </li>
            `;

        })
        .join("");

}

function openToc() {

    const items =
        book &&
        book.navigation &&
        book.navigation.toc;

    if (!items || !items.length) {
        return;
    }

    tocList.innerHTML = renderTocItems(items);
    tocOverlay.hidden = false;
    tocPanel.scrollTop = 0;

    tocList
        .querySelectorAll(".toc-link")
        .forEach(link => {

            link.addEventListener("click", () => {

                const href = link.dataset.href;

                tocOverlay.hidden = true;

                if (rendition && href) {
                    rendition.display(href);
                }

            });

        });

}

function closeToc() {
    tocOverlay.hidden = true;
}

tocButton.addEventListener("click", openToc);
tocPanelClose.addEventListener("click", closeToc);

tocOverlay.addEventListener("click", event => {
    if (event.target === tocOverlay) {
        closeToc();
    }
});


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

    await book.ready;

    const bookKey = getBookStorageKey(book, file);

    rendition = book.renderTo(viewer, {
        width: "100%",
        height: "100%",
        flow: "paginated"
    });

    attachWordTapListeners(rendition);

    rendition.on("relocated", location => {
        saveReadingPosition(
            bookKey,
            location && location.start && location.start.cfi
        );
    });

    const savedPosition =
        loadReadingPosition(bookKey);

    if (savedPosition) {
        await rendition.display(savedPosition);
    } else {
        await rendition.display();
    }

    applyReaderFontScale();
    applyReaderTheme();

    emptyState.hidden = true;
    readerArea.hidden = false;
    tocButton.hidden =
        !(book.navigation && book.navigation.toc && book.navigation.toc.length);

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

wordSearchForm.addEventListener("submit", event => {

    event.preventDefault();

    const word = wordSearchInput.value.trim();

    if (!word) {
        return;
    }

    hideSearchSuggestions();
    handleWordTap(word);

    wordSearchInput.value = "";
    wordSearchInput.blur();

});


// Suggestions as you type: the tapped/typed word might be an inflected
// form of something that already exists in ZWords under a different
// spelling ("running" vs "run") -- resolveWord() already handles that
// at submit time via the lemma candidates, but showing close prefix
// matches from the word index while typing lets the reader notice and
// pick the right headword before even submitting.
function hideSearchSuggestions() {
    wordSearchSuggestions.hidden = true;
    wordSearchSuggestions.innerHTML = "";
}

// Searches both the words index and the phrasal verbs index -- typed
// search can match a multi-word phrase ("give up"), unlike a tap on a
// single word in the book, so suggestions should surface those too.
function getWordSuggestions(prefix) {

    const key = ZWordsSharedStatus.normalizeSharedWord(prefix);

    if (!key) {
        return [];
    }

    const matches = [];

    for (const index of [
        wordIndex,
        irregularWordIndex,
        phrasalVerbIndex,
        phraseIndex
    ]) {

        for (const candidateKey of Object.keys(index)) {

            if (candidateKey.startsWith(key)) {
                matches.push({ key: candidateKey, entry: index[candidateKey] });
            }

        }

    }

    matches.sort(
        (a, b) =>
            a.key.length - b.key.length ||
            a.key.localeCompare(b.key)
    );

    return matches.slice(0, 8);

}

function renderSearchSuggestions(prefix) {

    const suggestions = getWordSuggestions(prefix);

    if (!suggestions.length) {
        hideSearchSuggestions();
        return;
    }

    wordSearchSuggestions.innerHTML = suggestions
        .map(({ entry }) => {

            const firstSense = (entry.senses && entry.senses[0]) || {};

            return `
                <li class="word-search-suggestion" data-word="${entry.word}">
                    <span class="word-search-suggestion-word">${entry.word}</span>
                    <span class="word-search-suggestion-pos">${firstSense.part_of_speech || ""}</span>
                    <span class="word-search-suggestion-def">${firstSense.definition || ""}</span>
                </li>
            `;

        })
        .join("");

    wordSearchSuggestions.hidden = false;

    wordSearchSuggestions
        .querySelectorAll(".word-search-suggestion")
        .forEach(item => {

            item.addEventListener("mousedown", event => {
                // mousedown (not click) fires before the input's blur,
                // so the tap registers before hideSearchSuggestions()
                // on blur would otherwise remove this element first.
                event.preventDefault();

                const word = item.dataset.word;

                wordSearchInput.value = "";
                hideSearchSuggestions();
                handleWordTap(word);

            });

        });

}

let suggestionsDebounceTimer = null;

wordSearchInput.addEventListener("input", () => {

    clearTimeout(suggestionsDebounceTimer);

    const value = wordSearchInput.value.trim();

    if (!value) {
        hideSearchSuggestions();
        return;
    }

    suggestionsDebounceTimer = setTimeout(() => {
        renderSearchSuggestions(value);
    }, 120);

});

wordSearchInput.addEventListener("blur", () => {
    setTimeout(hideSearchSuggestions, 150);
});

// GIF Cards - SillyTavern extension
//
// Lets individual characters have an animated GIF as their card image.
//  - Tap a character's avatar (the normal picker) and choose a GIF: it becomes animated.
//    Choose a normal image later to go back.
//  - Works when creating a new character too.
//  - "Export" on a GIF character saves a real .gif file that carries the full card inside.
//  - Import such .gif files (Import button, or drag and drop) to create the character.
//
// Only characters you give a GIF to are affected. Everything else is untouched.
// The character itself stays a normal ST card; the GIF is stored in your user files
// and shown wherever ST shows that character's avatar.

import { isGif, readGifCard, writeGifCard, firstFrameToPng, bytesToBase64 } from './gif-card.js';

const MODULE = 'gifcards';
const DEFAULTS = Object.freeze({ enabled: true, animateLists: true, map: {} });
const HEAVY_BYTES = 8 * 1024 * 1024;
const AVATAR_INPUT_ID = 'add_avatar_button';

// Places that show many avatars at once (used by the "animate in lists" setting)
const LIST_SELECTOR = '#rm_print_characters_block, .welcomePanel, #rm_group_members, #rm_group_add_members';
// Places where dropped GIFs belong to something else (chat attachments, galleries, ...)
const DROP_IGNORE_SELECTOR = '#form_sheld, #chat, .popup, #select_chat_popup, textarea, input, [id^="dragGallery"]';

/* ------------------------------------------------------------------ i18n */

const STRINGS = {
    en: {
        selectChar: 'Select a character first.',
        notGif: 'That file is not a GIF.',
        heavy: 'This GIF is {mb} MB. Big GIFs can make lists slow, especially on phones.',
        gifSet: 'GIF attached.',
        gifPending: 'GIF ready. It will be attached when you create the character.',
        gifRemoved: 'GIF removed.',
        noGif: 'This character has no GIF.',
        failed: 'GIF Cards: something went wrong ({msg}).',
        exported: 'Exported {name}.gif',
        imported: 'Imported GIF card: {name}',
        importedBlank: 'That GIF had no card data. Created an empty character named "{name}".',
        exportLabel: 'GIF',
        settingsTitle: 'GIF Cards',
        settingEnabled: 'Show animated GIFs',
        settingLists: 'Animate in character lists too',
        settingListsHint: 'Turn this off on slow phones to keep lists static; GIFs still animate in chat and the character panel.',
        usage: 'Tap a character\'s avatar and pick a GIF to animate it (pick a normal image to go back). Export on a GIF character saves a .gif card with all its data; import it again with the Import button or by dropping it into the app.',
    },
    es: {
        selectChar: 'Primero selecciona un personaje.',
        notGif: 'Ese archivo no es un GIF.',
        heavy: 'Este GIF pesa {mb} MB. Los GIF grandes pueden alentar las listas, sobre todo en el celular.',
        gifSet: 'GIF asignado.',
        gifPending: 'GIF listo. Se asignará cuando crees el personaje.',
        gifRemoved: 'GIF quitado.',
        noGif: 'Este personaje no tiene GIF.',
        failed: 'GIF Cards: algo salió mal ({msg}).',
        exported: 'Exportado {name}.gif',
        imported: 'Card GIF importada: {name}',
        importedBlank: 'Ese GIF no tenía datos de card. Creé un personaje vacío llamado "{name}".',
        exportLabel: 'GIF',
        settingsTitle: 'GIF Cards',
        settingEnabled: 'Mostrar GIFs animados',
        settingLists: 'Animar también en las listas de personajes',
        settingListsHint: 'Desactívalo en celulares lentos para dejar las listas estáticas; en el chat y en el panel del personaje se siguen animando.',
        usage: 'Toca el avatar de un personaje y elige un GIF para animarlo (elige una imagen normal para volver). Exportar en un personaje con GIF guarda una card .gif con todos sus datos; vuelve a importarla con el botón Importar o soltándola en la app.',
    },
};

function locale() {
    let loc = '';
    try { loc = String(ctx().getCurrentLocale?.() || ''); } catch { /* ignore */ }
    return (loc || navigator.language || 'en').toLowerCase().startsWith('es') ? 'es' : 'en';
}

function tr(key, vars = {}) {
    const table = STRINGS[locale()] || STRINGS.en;
    let text = table[key] ?? STRINGS.en[key] ?? key;
    for (const [name, value] of Object.entries(vars)) text = text.replaceAll(`{${name}}`, String(value));
    return text;
}

/* -------------------------------------------------------------- helpers */

const ctx = () => SillyTavern.getContext();

function getSettings() {
    const store = ctx().extensionSettings;
    if (!store[MODULE]) store[MODULE] = {};
    const settings = store[MODULE];
    for (const [key, value] of Object.entries(DEFAULTS)) {
        if (!(key in settings)) settings[key] = structuredClone(value);
    }
    return settings;
}

const saveSettings = () => ctx().saveSettingsDebounced();

function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}

function reportError(error) {
    console.error('[GIF Cards]', error);
    toastr.error(tr('failed', { msg: errorMessage(error) }));
}

const isGifFileObject = (file) => file.type === 'image/gif' || /\.gif$/i.test(file.name);

/** The character open in the editor, if any. */
function currentCharacter() {
    const c = ctx();
    return c.characterId !== undefined ? c.characters[c.characterId] : undefined;
}

const inCreateMode = () => ctx().menuType === 'create';

/* ------------------------------------------------- avatar image swapping */

function avatarFileFromSrc(src) {
    try {
        const url = new URL(src, location.href);
        if (url.pathname !== '/thumbnail' || url.searchParams.get('type') !== 'avatar') return null;
        return url.searchParams.get('file');
    } catch {
        return null;
    }
}

function applyToImage(img) {
    const settings = getSettings();
    if (!settings.enabled) return;

    const src = img.getAttribute('src');
    if (!src) return;

    const file = avatarFileFromSrc(src);
    if (!file) {
        // Someone else changed this image (e.g. ST showing a freshly cropped avatar): forget our backup.
        if (img.dataset.gcOrig && !src.startsWith('/user/files/gifcard_')) delete img.dataset.gcOrig;
        return;
    }

    delete img.dataset.gcOrig;

    const entry = settings.map[file];
    if (!entry) return;
    if (!settings.animateLists && img.closest(LIST_SELECTOR)) return;

    img.dataset.gcOrig = src;
    img.setAttribute('src', entry.url);
}

function restoreAll() {
    for (const img of document.querySelectorAll('img[data-gc-orig]')) {
        if (!(img instanceof HTMLImageElement)) continue;
        img.setAttribute('src', img.dataset.gcOrig);
        delete img.dataset.gcOrig;
    }
}

function applyAll() {
    for (const img of document.querySelectorAll('img[src*="/thumbnail"]')) {
        if (img instanceof HTMLImageElement) applyToImage(img);
    }
}

function refreshImages() {
    restoreAll();
    applyAll();
}

const pendingNodes = new Set();
let flushScheduled = false;

function scheduleNode(node) {
    pendingNodes.add(node);
    if (flushScheduled) return;
    flushScheduled = true;
    requestAnimationFrame(() => {
        flushScheduled = false;
        const nodes = [...pendingNodes];
        pendingNodes.clear();
        for (const node of nodes) {
            if (!node.isConnected) continue;
            if (node instanceof HTMLImageElement) {
                applyToImage(node);
            } else {
                node.querySelectorAll?.('img[src*="/thumbnail"]').forEach(img => applyToImage(/** @type {HTMLImageElement} */ (img)));
            }
        }
    });
}

function startObserver() {
    const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            if (mutation.type === 'attributes') {
                scheduleNode(mutation.target);
            } else {
                mutation.addedNodes.forEach(node => node.nodeType === Node.ELEMENT_NODE && scheduleNode(node));
            }
        }
    });
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['src'] });
}

/* ------------------------------------------------------- storing GIFs */

async function uploadGif(avatar, bytes) {
    const base = avatar.replace(/\.png$/i, '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40) || 'card';
    const name = `gifcard_${base}_${Date.now().toString(36)}.gif`;
    const response = await fetch('/api/files/upload', {
        method: 'POST',
        headers: ctx().getRequestHeaders(),
        body: JSON.stringify({ name, data: bytesToBase64(bytes) }),
    });
    if (!response.ok) throw new Error(`upload failed (${response.status})`);
    const { path } = await response.json();
    return { url: '/' + String(path).replace(/^\/+/, ''), name, size: bytes.length };
}

async function deleteStoredGif(url) {
    try {
        await fetch('/api/files/delete', {
            method: 'POST',
            headers: ctx().getRequestHeaders(),
            body: JSON.stringify({ path: String(url).replace(/^\/+/, '') }),
        });
    } catch (error) {
        console.warn('[GIF Cards] Could not delete old GIF', error);
    }
}

async function attachGif(avatar, bytes) {
    const settings = getSettings();
    const previous = settings.map[avatar];
    settings.map[avatar] = await uploadGif(avatar, bytes);
    saveSettings();
    if (previous) await deleteStoredGif(previous.url);
    refreshImages();
}

async function detachGif(avatar) {
    const settings = getSettings();
    const previous = settings.map[avatar];
    if (!previous) return;
    delete settings.map[avatar];
    saveSettings();
    refreshImages();
    await deleteStoredGif(previous.url);
}

/** Forget references whose file was deleted from disk. */
async function pruneMissingFiles() {
    const settings = getSettings();
    const entries = Object.entries(settings.map);
    if (!entries.length) return;
    try {
        const urls = entries.map(([, entry]) => entry.url.replace(/^\/+/, ''));
        const response = await fetch('/api/files/verify', {
            method: 'POST',
            headers: ctx().getRequestHeaders(),
            body: JSON.stringify({ urls }),
        });
        if (!response.ok) return;
        const verified = await response.json();
        let changed = false;
        for (const [avatar, entry] of entries) {
            if (verified[entry.url.replace(/^\/+/, '')] === false) {
                delete settings.map[avatar];
                changed = true;
            }
        }
        if (changed) {
            saveSettings();
            refreshImages();
        }
    } catch (error) {
        console.warn('[GIF Cards] Could not verify stored GIFs', error);
    }
}

/** Replaces the static (PNG) avatar of an existing character, keeping its card data. */
async function setStaticAvatar(avatar, png) {
    const form = new FormData();
    form.append('avatar', new File([png], 'avatar.png', { type: 'image/png' }));
    form.append('avatar_url', avatar);
    const response = await fetch('/api/characters/edit-avatar', {
        method: 'POST',
        headers: ctx().getRequestHeaders({ omitContentType: true }),
        body: form,
        cache: 'no-cache',
    });
    if (!response.ok) {
        console.warn('[GIF Cards] Could not set the static avatar', response.status);
        return;
    }
    // Bust the caches so the new first frame shows up wherever the GIF cannot
    const thumb = ctx().getThumbnailUrl('avatar', avatar);
    await fetch(thumb, { method: 'GET', cache: 'reload' }).catch(() => { });
    await fetch(`/characters/${avatar}`, { method: 'GET', cache: 'reload' }).catch(() => { });
}

/* ----------------------------------------- the normal avatar picker (tap) */

/** Set while we re-dispatch a change event ourselves, so we don't intercept it again. */
let redispatching = false;
/** GIF chosen while creating a new character; attached once the character exists. */
let pendingCreate = null;
let replacementWatcher = null;

function disarmReplacementWatcher() {
    replacementWatcher?.disconnect();
    replacementWatcher = null;
}

/**
 * The user picked a normal image for a character that has a GIF. If they confirm it
 * (ST shows the cropped result in the preview), the GIF is dropped.
 */
function watchForAvatarReplacement(avatar) {
    disarmReplacementWatcher();
    const preview = document.getElementById('avatar_load_preview');
    if (!preview) return;
    const observer = new MutationObserver(() => {
        const src = preview.getAttribute('src') || '';
        if (!/^(data|blob):/.test(src)) return;
        disarmReplacementWatcher();
        if (inCreateMode() || currentCharacter()?.avatar !== avatar) return;
        detachGif(avatar).then(() => toastr.info(tr('gifRemoved'))).catch(reportError);
    });
    observer.observe(preview, { attributes: true, attributeFilter: ['src'] });
    replacementWatcher = observer;
}

async function handleGifPicked(input, file) {
    disarmReplacementWatcher();

    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!isGif(bytes)) {
        input.value = '';
        toastr.error(tr('notGif'));
        return;
    }
    if (bytes.length > HEAVY_BYTES) toastr.warning(tr('heavy', { mb: (bytes.length / 1024 / 1024).toFixed(1) }));

    const png = await firstFrameToPng(new Blob([bytes], { type: 'image/gif' }));

    if (inCreateMode()) {
        // The character doesn't exist yet. Let ST continue with the GIF's first frame
        // (so the usual crop + create flow works) and attach the GIF after creation.
        const name = `gifcard_first_frame_${Date.now().toString(36)}.png`;
        const transfer = new DataTransfer();
        transfer.items.add(new File([png], name, { type: 'image/png' }));
        pendingCreate = { bytes, known: new Set(ctx().characters.map(c => c.avatar)) };
        input.files = transfer.files;
        redispatching = true;
        try {
            input.dispatchEvent(new Event('change', { bubbles: true }));
        } finally {
            redispatching = false;
        }
        toastr.info(tr('gifPending'));
        return;
    }

    const character = currentCharacter();
    input.value = '';
    if (!character) {
        toastr.info(tr('selectChar'));
        return;
    }

    // Existing character: no cropping (it would flatten the GIF). Use a centered 2:3 first frame as the static avatar.
    await setStaticAvatar(character.avatar, png);
    await attachGif(character.avatar, bytes);
    toastr.success(tr('gifSet'));
}

function onAvatarChange(event) {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || input.id !== AVATAR_INPUT_ID) return;
    if (redispatching) return;

    const file = input.files?.[0];
    if (!file) return;

    if (isGifFileObject(file)) {
        // Capture phase: stop ST's own handler (it would flatten the GIF into a PNG).
        event.stopImmediatePropagation();
        event.preventDefault();
        handleGifPicked(input, file).catch(reportError);
        return;
    }

    // A normal image
    if (inCreateMode()) {
        pendingCreate = null;
        return;
    }
    const character = currentCharacter();
    if (character && getSettings().map[character.avatar]) watchForAvatarReplacement(character.avatar);
}

/** After ST created the character from the form, give the new character its GIF. */
function tryAttachPendingCreate() {
    if (!pendingCreate) return;
    if (ctx().createCharacterData?.avatar) return; // the form hasn't been submitted yet
    const fresh = ctx().characters.filter(c => !pendingCreate.known.has(c.avatar));
    if (fresh.length !== 1) return;
    const { bytes } = pendingCreate;
    pendingCreate = null;
    attachGif(fresh[0].avatar, bytes)
        .then(() => toastr.success(tr('gifSet')))
        .catch(reportError);
}

/* ------------------------------------------------------ export / import */

function triggerDownload(blob, fileName) {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    setTimeout(() => {
        URL.revokeObjectURL(link.href);
        link.remove();
    }, 1000);
}

/** Saves the open character the same way ST's own Export does, and waits for it. */
function saveOpenCharacter() {
    const { eventSource, eventTypes } = ctx();
    return new Promise((resolve) => {
        const done = () => {
            clearTimeout(timer);
            eventSource.removeListener(eventTypes.CHARACTER_EDITED, done);
            resolve();
        };
        const timer = setTimeout(done, 8000);
        eventSource.on(eventTypes.CHARACTER_EDITED, done);
        $('#create_button').trigger('click');
    });
}

async function exportGifCard(avatar) {
    const entry = getSettings().map[avatar];
    if (!entry) {
        toastr.info(tr('noGif'));
        return;
    }

    const exportResponse = await fetch('/api/characters/export', {
        method: 'POST',
        headers: ctx().getRequestHeaders(),
        body: JSON.stringify({ format: 'json', avatar_url: avatar }),
    });
    if (!exportResponse.ok) throw new Error(`character export failed (${exportResponse.status})`);
    const cardJson = JSON.stringify(JSON.parse(await exportResponse.text()));

    const gifResponse = await fetch(entry.url, { cache: 'no-cache' });
    if (!gifResponse.ok) throw new Error(`could not read the stored GIF (${gifResponse.status})`);
    const gifBytes = new Uint8Array(await gifResponse.arrayBuffer());
    if (!isGif(gifBytes)) throw new Error('stored file is not a GIF');

    const character = ctx().characters.find(c => c.avatar === avatar);
    const baseName = String(character?.name || avatar.replace(/\.png$/i, '')).replace(/[\\/:*?"<>|]+/g, '_').trim() || 'character';

    triggerDownload(new Blob([writeGifCard(gifBytes, cardJson)], { type: 'image/gif' }), `${baseName}.gif`);
    toastr.success(tr('exported', { name: baseName }));
}

function hookExport() {
    document.addEventListener('click', (event) => {
        const target = event.target instanceof Element ? event.target : null;
        if (!target) return;

        // Opening the format list: the PNG entry becomes "GIF" for characters that have one.
        if (target.closest('#export_button')) {
            const character = currentCharacter();
            const hasGif = !!(character && getSettings().map[character.avatar]);
            const item = document.querySelector('.export_format[data-format="png"]');
            if (item) item.textContent = hasGif ? tr('exportLabel') : 'PNG';
            return;
        }

        const item = target.closest('.export_format');
        if (!item || item.getAttribute('data-format') !== 'png') return;
        const character = currentCharacter();
        if (!character || !getSettings().map[character.avatar]) return;

        // Take over: ST's own handler would download the old static PNG.
        event.stopImmediatePropagation();
        event.preventDefault();
        $('#export_button').trigger('click'); // lets ST close its popup and reset its own state
        const avatar = character.avatar;
        saveOpenCharacter().then(() => exportGifCard(avatar)).catch(reportError);
    }, true);
}

function blankCard(name) {
    return {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        name,
        description: '',
        personality: '',
        scenario: '',
        first_mes: '',
        mes_example: '',
        data: {
            name,
            description: '',
            personality: '',
            scenario: '',
            first_mes: '',
            mes_example: '',
            creator_notes: '',
            system_prompt: '',
            post_history_instructions: '',
            alternate_greetings: [],
            tags: [],
            creator: '',
            character_version: '',
            extensions: { talkativeness: 0.5, fav: false, world: '', depth_prompt: { prompt: '', depth: 4, role: 'system' } },
        },
    };
}

/** Creates a character from a GIF file and attaches the GIF to it. Returns the new avatar file name. */
async function importOneGifCard(file) {
    const c = ctx();
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!isGif(bytes)) throw new Error(tr('notGif'));

    const fallbackName = file.name.replace(/\.gif$/i, '').trim() || 'GIF';
    let cardText = readGifCard(bytes);
    let blank = false;
    if (cardText === null) {
        cardText = JSON.stringify(blankCard(fallbackName));
        blank = true;
    }
    const card = JSON.parse(cardText); // Throws a readable error if the embedded data is damaged
    const cardName = String(card?.data?.name || card?.name || fallbackName);

    // 1) Create the character from the card data
    const importForm = new FormData();
    importForm.append('avatar', new File([cardText], 'card.json', { type: 'application/json' }));
    importForm.append('file_type', 'json');
    importForm.append('user_name', c.name1);
    const importResponse = await fetch('/api/characters/import', {
        method: 'POST',
        headers: c.getRequestHeaders({ omitContentType: true }),
        body: importForm,
        cache: 'no-cache',
    });
    if (!importResponse.ok) throw new Error(`import failed (${importResponse.status})`);
    const imported = await importResponse.json();
    if (imported.error || !imported.file_name) throw new Error('the server rejected the card data');
    const avatar = `${imported.file_name}.png`;

    // 2) Use the GIF's first frame as the normal (static) avatar
    try {
        await setStaticAvatar(avatar, await firstFrameToPng(new Blob([bytes], { type: 'image/gif' })));
    } catch (error) {
        console.warn('[GIF Cards] Could not render the first frame', error);
    }

    // 3) Attach the GIF itself
    await c.getCharacters();
    await attachGif(avatar, bytes);

    try {
        const character = ctx().characters.find(x => x.avatar === avatar);
        if (character && typeof c.importTags === 'function') await c.importTags(character);
    } catch (error) {
        console.warn('[GIF Cards] Tag import failed', error);
    }

    toastr.success(blank ? tr('importedBlank', { name: cardName }) : tr('imported', { name: cardName }));
    return avatar;
}

let importing = false;

async function importGifCards(files) {
    if (importing) return;
    importing = true;
    try {
        let last = null;
        for (const file of files) {
            try {
                last = await importOneGifCard(file);
            } catch (error) {
                reportError(error);
            }
        }
        if (last) {
            await ctx().getCharacters();
            const index = ctx().characters.findIndex(c => c.avatar === last);
            if (index !== -1) await ctx().selectCharacterById(index);
        }
    } finally {
        importing = false;
    }
}

function hookImports() {
    // Capture phase: we see the files before ST's own handler clears the input.
    document.addEventListener('change', (event) => {
        const target = event.target;
        if (!(target instanceof HTMLInputElement) || target.id !== 'character_import_file') return;
        const gifs = Array.from(target.files || []).filter(isGifFileObject);
        if (gifs.length) importGifCards(gifs);
    }, true);

    document.addEventListener('drop', (event) => {
        const files = Array.from(event.dataTransfer?.files || []);
        const gifs = files.filter(isGifFileObject);
        if (!gifs.length) return;
        if (event.target instanceof Element && event.target.closest(DROP_IGNORE_SELECTOR)) return;
        importGifCards(gifs);
        if (gifs.length === files.length) {
            // Nothing else was dropped: keep ST from complaining about an "unsupported file".
            event.preventDefault();
            event.stopImmediatePropagation();
        }
    }, true);
}

/* -------------------------------------------------------------- the UI */

function allowGifInImportPicker() {
    const input = document.getElementById('character_import_file');
    if (!(input instanceof HTMLInputElement)) return;
    const accept = input.getAttribute('accept') || '';
    if (!/image\/gif/.test(accept)) input.setAttribute('accept', `${accept}, image/gif`.replace(/^, /, ''));
}

function addSettingsPanel() {
    if (document.getElementById('gifcards_settings')) return;
    const settings = getSettings();
    const $panel = $(`
        <div id="gifcards_settings" class="extension_container">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b></b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <small class="gc-usage"></small>
                    <label class="checkbox_label"><input type="checkbox" id="gifcards_enabled"><span class="gc-enabled"></span></label>
                    <label class="checkbox_label"><input type="checkbox" id="gifcards_lists"><span class="gc-lists"></span></label>
                    <small class="gc-lists-hint"></small>
                </div>
            </div>
        </div>`);
    $panel.find('b').text(tr('settingsTitle'));
    $panel.find('.gc-usage').text(tr('usage'));
    $panel.find('.gc-enabled').text(tr('settingEnabled'));
    $panel.find('.gc-lists').text(tr('settingLists'));
    $panel.find('.gc-lists-hint').text(tr('settingListsHint'));
    $panel.find('#gifcards_enabled').prop('checked', settings.enabled).on('change', function () {
        settings.enabled = $(this).prop('checked');
        saveSettings();
        refreshImages();
    });
    $panel.find('#gifcards_lists').prop('checked', settings.animateLists).on('change', function () {
        settings.animateLists = $(this).prop('checked');
        saveSettings();
        refreshImages();
    });
    $('#extensions_settings2').append($panel);
}

function hookCharacterEvents() {
    const { eventSource, eventTypes } = ctx();

    eventSource.on(eventTypes.CHARACTER_RENAMED, (oldAvatar, newAvatar) => {
        const settings = getSettings();
        if (settings.map[oldAvatar]) {
            settings.map[newAvatar] = settings.map[oldAvatar];
            delete settings.map[oldAvatar];
            saveSettings();
            refreshImages();
        }
    });

    eventSource.on(eventTypes.CHARACTER_DELETED, (payload) => {
        const avatar = payload?.character?.avatar;
        if (avatar && getSettings().map[avatar]) detachGif(avatar).catch(reportError);
    });

    // A character was just created from the form: it may be waiting for its GIF.
    eventSource.on(eventTypes.CHARACTER_PAGE_LOADED, tryAttachPendingCreate);
    eventSource.on(eventTypes.CHARACTER_EDITOR_OPENED, tryAttachPendingCreate);
}

jQuery(async () => {
    try {
        getSettings();
        addSettingsPanel();
        allowGifInImportPicker();
        hookImports();
        hookExport();
        document.addEventListener('change', onAvatarChange, true);
        hookCharacterEvents();
        startObserver();
        applyAll();
        pruneMissingFiles();
    } catch (error) {
        console.error('[GIF Cards] Failed to initialise', error);
    }
});

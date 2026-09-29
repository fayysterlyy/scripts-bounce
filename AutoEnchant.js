// AutoEnchant.js - LiquidBounce script (MC 26.2 client, enchanting table)
// Enchanting tablede kitabi otomatik buyur.
//   - Seviye dropdown: En Yuksek / Seviye 1 / 2 / 3 (masadaki 3 secenek satiri)
//   - Sonuc dropdown: Envantere Al / Yere At
//     (Yere At: sadece ENCHANTED book yere atilir, normal book ASLA atmaz)
//   - Kitap + lapis envanterden her zaman otomatik yuklenir
//   - Tekrar: kitap bitene kadar devam eder
//   - Gecikme: saniye (float, orn. 0.2 = 4 tick) - uc islemi de kapsar (yukle/bas/al-at)
//   - GecikmeYok: acikken uc islem (yukle/bas/al) 1 tick (50ms) arayla, hizli
//     ama sunucu dostu (20 aksiyon/sn)
//   - AutoXp: XP bitince tabloyu kapatir, envanterden 1 xp sisesine sag tiklar
//     (sunucu plugini: 1 sise = XP), slotu 1. slota cekip kamera hic oynamadan
//     ATAR ATMAZ tabloyu yeniden acar
// Mekanik 26.2 kaynak kodundan birebir (EnchantmentMenu/MultiPlayerGameMode):
//   - slot0 = esya (kitap), slot1 = lapis, SONUC YOK: buyu basilinca slot0'da
//     kitap ENCHANTED_BOOK'a donusur (transmuteCopy)
//   - Secenek maliyeti: XP = costs[i], lapis = i+1 adet
//   - basilis: menu.clickMenuButton(player, i) + gameMode.handleInventoryButtonClick
//   - slot tiklamalari: gameMode.handleContainerInput(..., ContainerInput.X, player)
// Event: @Tag("gameTick") - "tick" DEGIL (docs yaniltici, bilinmeyen ad sessizce yutulur)

const script = registerScript({
    name: "AutoEnchant",
    version: "1.8.1",
    authors: ["kral"]
});

/* ================= Java bindings ================= */

const Items = Java.type("net.minecraft.world.item.Items");
const EnchMenu = Java.type("net.minecraft.world.inventory.EnchantmentMenu");
const ContainerInput = Java.type("net.minecraft.world.inventory.ContainerInput");
const InvScreenCls = Java.type("net.minecraft.client.gui.screens.inventory.InventoryScreen");
const InteractionHand = Java.type("net.minecraft.world.InteractionHand");
const BlockPos = Java.type("net.minecraft.core.BlockPos");
const Blocks = Java.type("net.minecraft.world.level.block.Blocks");
const Vec3 = Java.type("net.minecraft.world.phys.Vec3");
const Direction = Java.type("net.minecraft.core.Direction");
const BlockHitResult = Java.type("net.minecraft.world.phys.BlockHitResult");

/* ================= Durum ================= */

let mod = null;
let active = false;
let fatalFired = false;
let lastErrMsg = "";
let lastErrTime = 0;

let tickN = 0;
let nextAction = 0;
let done = false;          // repeat kapali: bir kitap bitti, bekle
let lastMenu = null;
let lastS0 = "";
let stuckKey = "";
let stuckN = 0;
let toldBook = false;    // "kitap bitti": bitis doneminde 1 kez yazildi mi
let toldLapis = false;   // "lapis bitti"
let toldXp = false;      // "XP seviyesi yetersiz"
let toldBottle = false;  // "xp sisesi yok"
let refill = 0;          // AutoXp doldurma durumu (0 = kapali, 1,3,6,7,8 = adimlar)
let refillT = 0;         // adim bazlangic tick'i
let refillStart = 0;     // sise tasinma toplam timeout
let refillPos = null;    // bulunan enchanting table konumu (trigger'da onceden bulunur)
let xpBlocked = false;   // sise/tablo sorunu: basarili buyu gorene kadar tekrar tetikleme yok
let pipe = 0;            // spekulatif boru hatti:1 = ench paketi gitti, beklemeden topla
let refillCd = 0;        // AutoXp cooldown (tick)

/* ================= Yardimcilar ================= */

function chat(m) {
    try { Client.displayChatMessage("AutoEnchant: " + m); } catch (e) { /* yoksay */ }
}

// mesaj: sadece acikken, ayni anahtar 5 sn'de bir (XP mesaji icin)
function msg(key, text) {
    if (!cfg("messages", true)) return;
    const now = Date.now();
    if (key === lastMsgKey && now - lastMsgTime < 5000) return;
    lastMsgKey = key;
    lastMsgTime = now;
    chat(text);
}
let lastMsgKey = "";
let lastMsgTime = 0;

function fatal(where, e) {
    if (fatalFired) return;
    fatalFired = true;
    active = false;
    const m = (e && (e.stack || e.message || String(e))) || String(e);
    chat("HATA (" + where + "): " + m);
    try { mod.enabled = false; } catch (e2) { /* yoksay */ }
}

function errOnce(where, e) {
    const m = (e && (e.message || String(e))) || String(e);
    const now = Date.now();
    if (m === lastErrMsg || now - lastErrTime < 3000) return;
    lastErrMsg = m;
    lastErrTime = now;
    chat(where + ": " + m);
}

function cfg(name, dflt) {
    try {
        if (mod !== null) {
            const s = mod.settings[name];
            if (s !== null && s !== undefined && s.value !== undefined && s.value !== null) return s.value;
        }
    } catch (e) { /* yoksay */ }
    return dflt;
}

// Gecikme saniye cinsinden (Setting.float) -> tick.
// Eski config "tick" degerleri (1..60 arasi tam sayi) geri dusumle korunur.
function delay() {
    // GecikmeYok acikken uc islem (yukle/bas/al) hizli ama 1 tick (50ms):
    // 0 degil -> 20 aksiyon/sn, sunucularda spam/anticheat sorunu cikarmaz
    if (cfg("noDelay", false)) return 1;
    const d = cfg("delay", 0.15);
    if (typeof d !== "number" || !isFinite(d)) return 3;
    if (d > 1) return Math.max(1, Math.min(60, Math.floor(d))); // eski tick degeri
    return Math.max(1, Math.round(d * 20));
}

// takilma korumasi: ayni anahtar 10 kez art arda denendiyse blokla (sessiz)
function stuckInc(k) {
    if (k === stuckKey) stuckN++;
    else { stuckKey = k; stuckN = 1; }
}
function stuckBlock(k) {
    return k === stuckKey && stuckN >= 10;
}
function stuckReset() {
    stuckKey = "";
    stuckN = 0;
}

function menuNow() {
    const m = rawMenu();
    return isEnchantMenu(m) ? m : null;
}

function rawMenu() {
    try {
        const p = mc.player;
        if (!p) return null;
        return p.containerMenu ? p.containerMenu : null;
    } catch (e) { return null; }
}

// E ile acilan vanilla envanter mi?
function isInvScreen() {
    try {
        const s = currentScreen();
        if (s && s instanceof InvScreenCls) return true;
    } catch (e) { /* yoksay */ }
    return false;
}

// Enchant menusu mu? HICBIR tek methoda/isime bagli degil - OR mantigi:
// instanceof tutmasa isim tutar, o da tutmazsa duck-type (sadece
// EnchantmentMenu'de public int[3] costs + clickMenuButton var) tutar.
function isEnchantMenu(m) {
    if (!m) return false;
    try { if (m instanceof EnchMenu) return true; } catch (e) { /* yoksay */ }
    try {
        if (String(m.getClass().getName()).lastIndexOf("EnchantmentMenu") >= 0) return true;
    } catch (e) { /* yoksay */ }
    try {
        const c = m.costs;
        if (c && c.length === 3 && typeof m.clickMenuButton === "function") return true;
    } catch (e) { /* yoksay */ }
    return false;
}

function slotItem(menu, i) {
    try { return menu.slots.get(i).getItem(); } catch (e) { return null; }
}

// slot0+slot1 imzasi: zincirlemede "durum degisti mi?" kontrolu.
// Tahmin yoksa (durum degismez) zincir hemen durur -> cift tiklama imkansiz.
function slotSig(menu) {
    try {
        const a = slotItem(menu, 0);
        const b = slotItem(menu, 1);
        return (a ? String(a) : "?") + "|" + (b ? String(b) : "?");
    } catch (e) { return "?"; }
}

function isBook(s) {
    try { return !s.isEmpty() && s.is(Items.BOOK); } catch (e) { return false; }
}
function isEncBook(s) {
    try { return !s.isEmpty() && s.is(Items.ENCHANTED_BOOK); } catch (e) { return false; }
}

function isInfinite() {
    try { return !!mc.player.hasInfiniteMaterials(); } catch (e) { return false; }
}

// envanter slotlari (2..): "book" | "lapis" ara, bulamazsan -1
function findInv(what) {
    const m = menuNow();
    if (!m) return -1;
    try {
        const n = m.slots.size();
        for (let i = 2; i < n; i++) {
            const s = m.slots.get(i).getItem();
            if (s.isEmpty()) continue;
            if (what === "book" && s.is(Items.BOOK)) return i;
            if (what === "lapis" && s.is(Items.LAPIS_LAZULI)) return i;
            if (what === "bottle" && s.is(Items.EXPERIENCE_BOTTLE)) return i;
        }
    } catch (e) { /* yoksay */ }
    return -1;
}

function clickSlot(menu, slot, button, type) {
    mc.gameMode.handleContainerInput(menu.containerId, slot, button, type, mc.player);
}

function currentScreen() {
    try { if (mc.screen) return mc.screen; } catch (e) { /* 26.2'de farkli olabilir */ }
    try { return mc.gui.screen(); } catch (e) { /* yoksay */ }
    return null;
}

function closeScreen() {
    try {
        const scr = currentScreen();
        if (!scr) return;
        try { scr.onClose(); } catch (e1) {
            try { scr.close(); } catch (e2) { /* yoksay */ }
        }
    } catch (e) { /* yoksay */ }
}

/* ================= Seviye secimi ================= */

// vanilla clickMenuButton kosullari birebir:
//   costs[i] > 0 && xp >= i+1 && xp >= costs[i] && lapis >= i+1
function chooseOption(menu, s1, infinite) {
    const costs = menu.costs;
    const want = String(cfg("level", "En Yuksek"));
    let order;
    if (want === "Seviye 1") order = [0];
    else if (want === "Seviye 2") order = [1];
    else if (want === "Seviye 3") order = [2];
    else order = [2, 1, 0]; // En Yuksek: en pahali satirdan basla

    let xp = 0;
    try { xp = mc.player.experienceLevel; } catch (e) { /* yoksay */ }
    let have = 0;
    try { if (!s1.isEmpty()) have = s1.getCount(); } catch (e) { /* yoksay */ }

    const pass = [];
    let anyCost = false;
    for (let k = 0; k < order.length; k++) {
        const i = order[k];
        if (costs[i] > 0) anyCost = true;
        if (costs[i] <= 0) continue;
        if (!infinite && (xp < i + 1 || xp < costs[i])) continue;
        pass.push(i);
    }
    if (pass.length === 0) {
        return { opt: -1, reason: anyCost ? "xp" : "cost" };
    }
    if (!infinite && have < pass[0] + 1) {
        // secili/en iyi adayin lapis yetmiyor: lapisin yetigi en iyisine dus
        for (let k = 0; k < pass.length; k++) {
            if (have >= pass[k] + 1) return { opt: pass[k], reason: "" };
        }
        return { opt: -1, reason: "lapis" };
    }
    return { opt: pass[0], reason: "" };
}

/* ================= Adimlar ================= */

function collect(menu) {
    const dest = String(cfg("dest", "Envantere Al"));
    const k = dest === "Yere At" ? "drop" : "take";
    if (stuckBlock(k)) return;

    pipe = 0; // toplama tiklamasi gitti: spekulatif asama bitti
    const cur = slotItem(menu, 0);
    const enc = !!(cur && !cur.isEmpty() && isEncBook(cur));
    if (dest === "Yere At") {
        // kural: SADECE enchanted book yere atilir; normal book hicbir kosulda
        // yere gitmez (emniyet: enc degilse envantere al)
        if (enc) clickSlot(menu, 0, 1, ContainerInput.THROW);
        else clickSlot(menu, 0, 0, ContainerInput.QUICK_MOVE);
    } else {
        clickSlot(menu, 0, 0, ContainerInput.QUICK_MOVE);
        const after = slotItem(menu, 0);
        if (after && !after.isEmpty()) {
            stuckInc(k);
            nextAction = tickN + delay();
            return;
        }
    }

    nextAction = tickN + delay();
    stuckInc(k);
    if (!cfg("repeat", true)) {
        done = true;
        if (cfg("closeAfter", false)) closeScreen();
    }
}

function step(menu) {
    const s0 = slotItem(menu, 0);
    const s1 = slotItem(menu, 1);
    if (!s0 || !s1) return;

    // slot0 icerigi degistiyse takilma sayaclari sifirla
    const cur0 = s0.isEmpty() ? "empty" : String(s0.getItem());
    if (cur0 !== lastS0) { lastS0 = cur0; stuckReset(); pipe = 0; }

    if (done) {
        // repeat kapali: sadece yeni kitap slot0'a konulursa devam
        if (isBook(s0)) done = false;
        else return;
    }

    const infinite = isInfinite();

    // 1) buyu basilmis kitap -> topla. pipe=1 ise sonucu beklemeden spekulatif
    //    topla: paket sirasi (ench -> topla -> yukle) TCP'de korunur, sunucu
    //    once enchant'i isler -> hizlanma + gecikme/sunucu gecikmesi farki yok
    if (isEncBook(s0) || pipe === 1) { collect(menu); return; }

    // 2) slot bos -> kitap yukle
    if (s0.isEmpty()) {
        const b = findInv("book");
        if (b < 0) {
            if (!toldBook) { toldBook = true; msg("nobook", "kitap bitti"); }
            if (cfg("closeAfter", false)) closeScreen();
            return;
        }
        toldBook = false;
        const k = "book:" + b;
        if (stuckBlock(k)) return;
        clickSlot(menu, b, 0, ContainerInput.QUICK_MOVE);
        nextAction = tickN + delay();
        stuckInc(k);
        return;
    }

    // 3) slot0'da kitap disi bir sey varsa: geri al (her zaman)
    if (!isBook(s0)) {
        const k = "clear";
        if (stuckBlock(k)) return;
        clickSlot(menu, 0, 0, ContainerInput.QUICK_MOVE);
        nextAction = tickN + delay();
        stuckInc(k);
        return;
    }

    // 4) secenek sec + kosul kontrol + bas
    const ch = chooseOption(menu, s1, infinite);
    if (ch.opt < 0) {
        if (ch.reason === "lapis") {
            const li = findInv("lapis");
            if (li >= 0) {
                toldLapis = false;
                const k = "lapis:" + li;
                if (stuckBlock(k)) return;
                clickSlot(menu, li, 0, ContainerInput.QUICK_MOVE);
                nextAction = tickN + delay();
                stuckInc(k);
            } else if (!toldLapis) {
                toldLapis = true;
                msg("nolapis", "lapis bitti");
            }
            return;
        }
        // XP yetersiz: bitis doneminde 1 kez yaz
        if (ch.reason === "xp" && !toldXp) {
            toldXp = true;
            msg("noxp", "XP seviyesi yetersiz");
        }
        // AutoXp: XP bitti -> kapat, 1 sise at, slotu sise disi bir slota cek, atar atmaz ac
        if (ch.reason === "xp" && cfg("autoXp", false) && refill === 0 && !xpBlocked && tickN >= refillCd) {
            if (findInv("bottle") < 0) {
                if (!toldBottle) {
                    toldBottle = true;
                    msg("nobottle", "xp sisesi yok");
                }
            } else {
                refillPos = findEnchTable(); // tabloyu ONCEDEN bul: kapat/ac hizli aksin
                if (refillPos) {
                    refillCd = tickN + 60; // ani dongu korumasi (3 sn)
                    refill = 1;
                } else {
                    xpBlocked = true; // cevrede tablo yok: gereksiz dongu kurma
                }
            }
        }
        return;
    }

    // gecerli secenek var -> uyari donemleri bitti
    toldBook = false;
    toldLapis = false;
    toldXp = false;
    toldBottle = false;
    xpBlocked = false;
    refillCd = 0; // basarili secenek goruldu: sise islev gordu, cooldown sifirla

    const opt = ch.opt;
    const ek = "ench:" + opt;
    if (stuckBlock(ek)) return;

    let ok = false;
    try {
        ok = menu.clickMenuButton(mc.player, opt);
    } catch (e) {
        errOnce("enchant", e);
        return;
    }
    if (!ok) {
        stuckInc(ek);
        return;
    }
    try {
        mc.gameMode.handleInventoryButtonClick(menu.containerId, opt);
    } catch (e) {
        errOnce("packet", e);
    }
    // Yere At modunda spekulatif bekleme YOK: pipe=1 ile sonuc gelmeden
    // tiklanirsa tahmin yerelde NORMAL book'u gorur -> yanlislikla book yere
    // duser. Orada sunucu paketi (ench sonucu) bekle; Envantere Al modunda
    // pipe acik kalir (hiz icin; tahmin sonradan SetSlot ile duzelir).
    if (String(cfg("dest", "Envantere Al")) !== "Yere At") pipe = 1; // ench paketi gitti: beklemeden topla
    nextAction = tickN + delay();
    stuckInc(ek);
}

/* ================= AutoXP doldurma ================= */

// XP bitince: tabloyu KAPAT -> 1 sise at -> slotu sise disi slota cek -> ATAR
// ATMAZ tekrar ac. Hicbir adimda bekleme/lookAt yok (paketler TCP'de sirali);
// sadece envanter tasima (asama6) gecici yutulursa 5 tick'ta bir tekrar dener.
// HATA/degerlendirme disi her adim timeout'lu; takilirsa xpBlocked = true
// (basarili buyu gorene kadar tekrar denemez, dongu olmasin).
function runRefill() {
    switch (refill) {
        case 1: { // 1) enchanting table kapat
            try {
                const s = currentScreen();
                if (s) { try { s.onClose(); } catch (e) { /* yoksay */ } }
            } catch (e) { /* yoksay */ }
            try {
                if (currentScreen()) mc.gui.setScreen(null); // ACS.removed -> closeContainer
            } catch (e) { /* yoksay */ }
            refill = 3; // bekleme yok: close/throw/ac paketleri TCP'de sirali
            break;
        }

        case 3: { // 3) sise bul: hotbar'da -> kullan, ana envanterde -> hotbar'a tasi
            let hot = -1, main = -1;
            for (let i = 0; i < 36; i++) {
                const st = mc.player.getInventory().getItem(i);
                if (st && !st.isEmpty() && st.is(Items.EXPERIENCE_BOTTLE)) {
                    if (i < 9) { hot = i; break; }
                    main = i;
                }
            }
            if (hot >= 0) { useBottle(hot); break; }
            if (main >= 0) {
                quickMoveBottle(main);
                refillT = tickN;
                refillStart = tickN;
                refill = 6;
                break;
            }
            xpBlocked = true;
            refill = 7; // sise yokken de tabloyu geri ac
            break;
        }

        case 6: { // 6) hotbar'a dustu mu? (yoksa 5 tick'te bir tekrar tasi)
            let hot = -1, main = -1;
            for (let i = 0; i < 36; i++) {
                const st = mc.player.getInventory().getItem(i);
                if (st && !st.isEmpty() && st.is(Items.EXPERIENCE_BOTTLE)) {
                    if (i < 9) { hot = i; break; }
                    main = i;
                }
            }
            if (hot >= 0) { useBottle(hot); break; }
            if (main >= 0 && tickN - refillT >= 5) {
                quickMoveBottle(main);
                refillT = tickN;
            }
            if (tickN - refillStart > 40) { xpBlocked = true; refill = 7; }
            break;
        }

        case 7: // sise atildi -> HEMEN tabloyu ac (kamera/karakter bakisi hic oynanmaz)
            if (!refillPos) { xpBlocked = true; refill = 0; break; }
            try {
                const hit = new BlockHitResult(tableCenter(refillPos), Direction.UP, refillPos, false);
                mc.gameMode.useItemOn(mc.player, InteractionHand.MAIN_HAND, hit);
                mc.player.swing(InteractionHand.MAIN_HAND);
                refillT = tickN;
                refill = 8;
            } catch (e) {
                errOnce("autoxp", e);
                xpBlocked = true;
                refill = 0;
            }
            break;

        case 8: // 8) menu acildi mi? (60 tick)
            if (menuNow()) refill = 0;
            else if (tickN - refillT > 60) { xpBlocked = true; refill = 0; }
            break;
    }
}

// hotbar secimini degistir + 1 kez sag tik (1 sise = 1 XP, sunucu plugini),
// atar ATMAZ slotu her zaman 1. slota cek (kullanici istegi), sonra acilir.
// Paket sirasi: useItem once carried-slot paketini gonderir
// (ensureHasSentCarriedItem), yani dogru slotla sag tiklanir; sonraki
// useItemOn de once yeni slota gecis paketini yollar. Sira bozulmaz.
function useBottle(idx) {
    try {
        mc.player.getInventory().setSelectedSlot(idx);
        mc.gameMode.useItem(mc.player, InteractionHand.MAIN_HAND);
        mc.player.swing(InteractionHand.MAIN_HAND);
        mc.player.getInventory().setSelectedSlot(0); // 1. slot (9. slot DEGIL)
        refillT = tickN;
        refill = 7;
    } catch (e) {
        errOnce("autoxp", e);
        xpBlocked = true;
        refill = 7;
    }
}

// envanter slotunu (9..35) shift-click ile hotbar'a tasi (menu kapaliyken de calisir)
function quickMoveBottle(slot) {
    try {
        const im = mc.player.inventoryMenu;
        mc.gameMode.handleContainerInput(im.containerId, slot, 0, ContainerInput.QUICK_MOVE, mc.player);
    } catch (e) {
        errOnce("autoxp", e);
    }
}

function tableCenter(pos) {
    return new Vec3(pos.getX() + 0.5, pos.getY() + 1.0, pos.getZ() + 0.5);
}

// oyuncunun cevresinde enchanting table ara (genislik 9x6x9)
function findEnchTable() {
    try {
        const p = mc.player;
        const px = Math.floor(p.getX()), py = Math.floor(p.getY()), pz = Math.floor(p.getZ());
        for (let dy = -2; dy <= 3; dy++) {
            for (let dx = -4; dx <= 4; dx++) {
                for (let dz = -4; dz <= 4; dz++) {
                    const pos = new BlockPos(px + dx, py + dy, pz + dz);
                    if (mc.level.getBlockState(pos).is(Blocks.ENCHANTING_TABLE)) return pos;
                }
            }
        }
    } catch (e) { errOnce("autoxp", e); }
    return null;
}

/* ================= Modul ================= */

script.registerModule({
    name: "AutoEnchant",
    category: "Player",
    description: "Enchanting tablede kitabi otomatik buyur (seviye + sonuc dropdown)",
    settings: {
        level: Setting.choose({
            name: "Seviye",
            default: "En Yuksek",
            choices: ["En Yuksek", "Seviye 1", "Seviye 2", "Seviye 3"]
        }),
        dest: Setting.choose({
            name: "Sonuc",
            default: "Envantere Al",
            choices: ["Envantere Al", "Yere At"]
        }),
        repeat: Setting.boolean({ name: "Tekrar", default: true }),
        delay: Setting.float({ name: "Gecikme", default: 0.15, range: [0.05, 1], suffix: "sn" }),
        noDelay: Setting.boolean({ name: "GecikmeYok", default: false }),
        autoXp: Setting.boolean({ name: "AutoXp", default: false }),
        closeAfter: Setting.boolean({ name: "BitinceKapat", default: false }),
        messages: Setting.boolean({ name: "Mesajlar", default: true })
    }
}, (m) => {
    mod = m;

    mod.on("enable", () => {
        active = true;
        fatalFired = false;
        tickN = 0;
        nextAction = 0;
        done = false;
        lastMenu = null;
        lastS0 = "";
        stuckReset();
        lastMsgKey = "";
        toldBook = false;
        toldLapis = false;
        toldXp = false;
        toldBottle = false;
        refill = 0;
        refillT = 0;
        xpBlocked = false;
        pipe = 0;
        refillCd = 0;
    });

    mod.on("disable", () => {
        active = false;
        lastMenu = null;
    });

    // Aksiyon kapisi + zincir. gameTick VE frame tetikleyicilerinden cagrilir
    // (idempotent): frame tetikleyicisi sunucu yanitina 1 frame icinde tepki verir;
    // delay>0 iken gate frame cagirilarini zaten kapali tutar (davranis degismez).
    // Emniyet: slot imzasi degismezse zincir aninda duser (cift tiklama imkansiz).
    function pulse() {
        if (!active) return;
        try {
            if (!mc || !mc.player || !mc.level) return;

            // AutoXp doldurma durum makinesi (menu kapaliyken de calisir;
            // calisiyorken normal enchant akisini bloklar)
            if (refill > 0) {
                runRefill();
                if (refill > 0) return;
            }

            const scr = currentScreen();

            // hic GUI acik degil veya E envanteri -> bekle
            if (!scr || isInvScreen()) {
                if (lastMenu !== null) { lastMenu = null; lastS0 = ""; stuckReset(); done = false; toldBook = false; toldLapis = false; toldXp = false; toldBottle = false; pipe = 0; }
                return;
            }

            // enchant menusu disindaki tum gui'ler (chest vs) -> bekle
            const menu = menuNow();
            if (!menu) {
                if (lastMenu !== null) { lastMenu = null; lastS0 = ""; stuckReset(); done = false; toldBook = false; toldLapis = false; toldXp = false; toldBottle = false; pipe = 0; }
                return;
            }

            if (menu !== lastMenu) {
                lastMenu = menu;
                lastS0 = "";
                stuckReset();
                done = false;
                toldBook = false;
                toldLapis = false;
                toldXp = false;
                toldBottle = false;
                pipe = 0;
            }
            if (tickN < nextAction) return;

            // zincirleme: durum degistikce ayni cagri icinde devam et (koy -> bas -> al
            // hepsi tek cagri'ye sigabilir). Durum degismezse zincir aninda duser,
            // yani tahmin yokken bile eski davranisa (1 aksiyon/tick) duser.
            let prev = slotSig(menu);
            for (let g = 0; g < 20; g++) {
                if (tickN < nextAction) break;
                step(menu);
                const now = slotSig(menu);
                if (now === prev) break;
                prev = now;
            }
        } catch (e) {
            fatal("tick", e);
        }
    }

    mod.on("gameTick", () => {
        if (!active) return;
        tickN++;
        pulse();
    });

    // frame hizi: gelen paketler frame araliginda islenir -> sunucu yanitini
    // 20 tick/sn'yi beklemeden 1 frame icinde uygula (GecikmeYok = max hiz).
    // Bunlar bilinmeyen ad olursa sessizce yutulur (mevcut davrans bozulmaz).
    mod.on("gameRenderTaskQueue", () => { pulse(); });
    mod.on("tickPacketProcess", () => { pulse(); });
});
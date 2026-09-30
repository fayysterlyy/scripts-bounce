// AutoMetin.js - LiquidBounce script (MC 26.2 client)
// 3 istasyon: Baritone ile git -> hedef bloga BAKARAK kir (blok respawn olur,
// bedrock gorene kadar ayni konum kirilir) -> bedrock ise sonraki istasyon,
// 3. istasyon bedrock ise basa don. Kirarken otomatik kazma + her 8 sn ziplama.
// Gitme koordinatlari ClickGUI'den "X Y Z" yazilir (1/2/3 istasyon).
// Mekanik 26.2 kaynagindan (MultiPlayerGameMode/LocalPlayer):
//   - continueDestroyBlock(pos, face): ayni hedefte cagrilmasi guvenli
//     (progress sifirlanmaz), havada no-op, once carried-slotu senkronlar
//     (ensureHasSentCarriedItem) -> kazma secimi sunucuya dogru gider.
//   - stopDestroyBlock: kirma birakilirken ABORT paketi yollar.
//   - ziplama: options.keyJump pulse (2 tick bas-birak).
// Baritone: OreSim'deki dogrulanmis kalip (GoalBlock + cancelEverywhere
// getPathingBehavior uzerinde).

const script = registerScript({
    name: "AutoMetin",
    version: "1.0.5",
    authors: ["kral"]
});

const BlockPos = Java.type("net.minecraft.core.BlockPos");
const Blocks = Java.type("net.minecraft.world.level.block.Blocks");
const Vec3 = Java.type("net.minecraft.world.phys.Vec3");
const Direction = Java.type("net.minecraft.core.Direction");
const ContainerInput = Java.type("net.minecraft.world.inventory.ContainerInput");
const EntityAnchor = Java.type("net.minecraft.commands.arguments.EntityAnchorArgument");
const Items = Java.type("net.minecraft.world.item.Items");

// gitme koordinatlari ClickGUI'den "X Y Z" yazilir (1/2/3 istasyon).
// kirma bloklari SABIT (degistirilmez).
const DEF_GOTO = [
    [36, 92, 18],
    [53, 92, 2],
    [38, 92, -16]
];
const DEF_MINE = [
    [38, 93, 18],
    [53, 93, 0],
    [38, 93, -18]
];
const GOTO_KEYS = ["goto1", "goto2", "goto3"];
let STS = []; // aktif istasyonlar (her tick ayarlardan kurulur)
let toldCoord = false;
let failN = 0;       // art arda ulasilamayan hedef sayisi (tani icin)
let toldFail = false;

function parseCoord(text, fb) {
    try {
        const p = String(text).trim().split(/\s+/);
        if (p.length < 3) return { v: fb, ok: false };
        const x = parseInt(p[0], 10), y = parseInt(p[1], 10), z = parseInt(p[2], 10);
        if (!isFinite(x) || !isFinite(y) || !isFinite(z)) return { v: fb, ok: false };
        if (y < -64 || y > 320) return { v: fb, ok: false };
        return { v: [x, y, z], ok: true };
    } catch (e) { return { v: fb, ok: false }; }
}

function stations() {
    const out = [];
    for (let i = 0; i < 3; i++) {
        const rg = cfg(GOTO_KEYS[i], "");
        const gg = parseCoord(rg, DEF_GOTO[i]);
        if (!gg.ok && String(rg).trim() !== "" && !toldCoord) {
            toldCoord = true;
            msg("koordinat hatali, varsayilan kullaniliyor");
        }
        const g = gg.v, b = DEF_MINE[i];
        out.push({ gx: g[0], gy: g[1], gz: g[2], bx: b[0], by: b[1], bz: b[2] });
    }
    return out;
}

// kazma onceligi (en iyi en basta)
const PICKS = ["NETHERITE_PICKAXE", "DIAMOND_PICKAXE", "IRON_PICKAXE", "STONE_PICKAXE", "WOODEN_PICKAXE", "GOLDEN_PICKAXE"];

/* ================= Durum ================= */

let mod = null;
let active = false;
let fatalFired = false;
let lastErrKey = "";
let lastErrTime = 0;

let tickN = 0;
let st = 0;            // istasyon index (0..2)
let phase = "goto";    // "goto" | "mine"
let goalSet = false;   // Baritone hedefi verildi mi
let gotoT = 0;         // goto baslangic tick'i (timeout)
let still = 0;         // hareketsiz tick sayaci
let lx = 0, ly = 0, lz = 0;
let rotWait = 0;       // mine girisinde rotasyon senkron beklemesi (tick)
let lastJump = 0;      // son ziplama tick'i
let jumpUntil = 0;     // ziplama tusu birakma tick'i
let moveT = 0;         // kazma tasima tekrar sayaci
let toldNoPick = false;
let toldNoBt = false;

/* ================= Yardimcilar ================= */

function chat(m) {
    try { Client.displayChatMessage("AutoMetin: " + m); } catch (e) { /* yoksay */ }
}

function cfg(n, d) {
    try {
        const v = mod.settings[n].value;
        return (v === undefined || v === null) ? d : v;
    } catch (e) { return d; }
}

function msg(text) {
    if (!cfg("messages", true)) return;
    chat(text);
}

// hata: ayni anahtar 60 sn'de bir (mesajdaki sayi degisse bile spam yok)
function errOnce(key, e) {
    try {
        const now = Date.now();
        if (key === lastErrKey && now - lastErrTime < 60000) return;
        lastErrKey = key;
        lastErrTime = now;
        const m = String((e && (e.message || e)) || e).slice(0, 120);
        chat("hata [" + key + "]: " + m);
    } catch (ex) { /* yoksay */ }
}

// olumcul: temizlik + dur (donguye girip oyunu yorma)
function fatal(e) {
    if (fatalFired) return;
    fatalFired = true;
    try {
        chat("fatal: " + String((e && (e.message || e)) || e).slice(0, 160));
    } catch (ex) { /* yoksay */ }
    cleanup();
    active = false;
}

function cleanup() {
    try { btCancel(); } catch (e) { /* yoksay */ }
    jumpOff();
    try { if (mc && mc.gameMode) mc.gameMode.stopDestroyBlock(); } catch (e) { /* yoksay */ }
}

function jumpOff() {
    jumpUntil = 0;
    try { mc.options.keyJump.setDown(false); } catch (e) { /* yoksay */ }
}

function jumpPulse() {
    try {
        mc.options.keyJump.setDown(true);
        jumpUntil = tickN + 2;
    } catch (e) { errOnce("jump", e); }
}

/* ================= Baritone (OreSim dogrulanmis kalip) ================= */

let btMode = null; // "direct" | "reflect"
let btErr = "";
let btIb = null, btGoalCls = null, btCgp = null, btPb = null;
let btR = null;

function btTryDirect() {
    const BA = Java.type("baritone.api.BaritoneAPI");
    btGoalCls = Java.type("baritone.api.pathing.goals.GoalBlock");
    btIb = BA.getProvider().getPrimaryBaritone();
    btCgp = btIb.getCustomGoalProcess();
    // cancelEverything IPathingBehavior'da, CustomGoalProcess'te DEGIL
    btPb = btIb.getPathingBehavior();
    btMode = "direct";
}

function btTryReflect(cl) {
    const Class = Java.type("java.lang.Class");
    const IntegerCls = Java.type("java.lang.Integer");
    const apiC = Class.forName("baritone.api.BaritoneAPI", false, cl);
    const provider = apiC.getMethod("getProvider").invoke(null);
    const ib = provider.getClass().getMethod("getPrimaryBaritone").invoke(provider);
    const cgp = ib.getClass().getMethod("getCustomGoalProcess").invoke(ib);
    const goalC = Class.forName("baritone.api.pathing.goals.GoalBlock", false, cl);
    const ifaceC = Class.forName("baritone.api.pathing.goals.Goal", false, cl);
    const ctor = goalC.getConstructor(IntegerCls.TYPE, IntegerCls.TYPE, IntegerCls.TYPE);
    const setM = cgp.getClass().getMethod("setGoalAndPath", ifaceC);
    const pb = ib.getClass().getMethod("getPathingBehavior").invoke(ib);
    const cancelM = pb.getClass().getMethod("cancelEverything");
    btR = { cgp: cgp, ctor: ctor, setM: setM, pb: pb, cancelM: cancelM };
    btMode = "reflect";
}

function baritoneReady() {
    if (btMode) return true;
    btErr = "";
    try {
        btTryDirect();
        return true;
    } catch (e) {
        btErr = "api:" + String(e && (e.message || e)).slice(0, 80);
    }
    const loaders = [];
    try { loaders.push(Java.type("java.lang.Thread").currentThread().getContextClassLoader()); } catch (e) { /* yoksay */ }
    try { loaders.push(mc.getClass().getClassLoader()); } catch (e) { /* yoksay */ }
    for (let i = 0; i < loaders.length; i++) {
        let cl = loaders[i];
        let hops = 0;
        while (cl && hops < 6) {
            try {
                btTryReflect(cl);
                return true;
            } catch (e) {
                btErr += " ld" + i + ":" + String(e && (e.message || e)).slice(0, 50);
            }
            try { cl = cl.getParent(); } catch (e) { break; }
            hops++;
        }
    }
    btErr = btErr.slice(0, 240);
    return false;
}

function btSetGoal(x, y, z) {
    if (btMode === "direct") {
        btCgp.setGoalAndPath(new btGoalCls(x, y, z));
    } else {
        const IntegerCls = Java.type("java.lang.Integer");
        btR.setM.invoke(btR.cgp,
            btR.ctor.newInstance(IntegerCls.valueOf(x), IntegerCls.valueOf(y), IntegerCls.valueOf(z)));
    }
}

function btCancel() {
    if (!btMode) return;
    if (btMode === "direct") {
        if (btPb) btPb.cancelEverything();
        else btIb.getPathingBehavior().cancelEverything();
    } else if (btMode === "reflect" && btR) {
        btR.cancelM.invoke(btR.pb);
    }
}

/* ================= Kazma ================= */

function bestPick() {
    let best = -1, bestScore = -1;
    for (let i = 0; i < 36; i++) {
        let item = null;
        try {
            const itemStack = mc.player.getInventory().getItem(i);
            if (!itemStack || itemStack.isEmpty()) continue;
            for (let p = 0; p < PICKS.length; p++) {
                let ok = false;
                try { ok = itemStack.is(Items[PICKS[p]]); } catch (e) { ok = false; }
                if (ok) {
                    const score = PICKS.length - p;
                    if (score > bestScore) { bestScore = score; best = i; }
                    break;
                }
            }
        } catch (e) { /* yoksay */ }
    }
    return best;
}

// true = kazma elde (kirilir), false = kirma (yok ya da tasiniyor)
function ensurePick() {
    const b = bestPick();
    if (b < 0) {
        if (!toldNoPick) { toldNoPick = true; msg("kazma yok"); }
        return false;
    }
    toldNoPick = false;
    if (b < 9) {
        try {
            if (mc.player.getInventory().getSelectedSlot() !== b) {
                mc.player.getInventory().setSelectedSlot(b);
            }
        } catch (e) { /* yoksay */ }
        return true;
    }
    // ana envanterde: hotbar'a cek (5 tick'te bir tekrar dene)
    if (tickN - moveT >= 5) {
        moveT = tickN;
        try {
            const im = mc.player.inventoryMenu;
            mc.gameMode.handleContainerInput(im.containerId, b, 0, ContainerInput.QUICK_MOVE, mc.player);
        } catch (e) { errOnce("pickmove", e); }
    }
    return false;
}

/* ================= Bakis + kirma ================= */

function wrapDeg(a) {
    let f = a % 360;
    if (f >= 180) f -= 360;
    if (f < -180) f += 360;
    return f;
}

// hedef blok merkezine bak; bakis oturduysa true (bakmadan kirma yok)
function aimAt(s) {
    const cx = s.bx + 0.5, cy = s.by + 0.5, cz = s.bz + 0.5;
    try {
        mc.player.lookAt(EntityAnchor.Anchor.EYES, new Vec3(cx, cy, cz));
    } catch (e) {
        errOnce("look", e);
        return false;
    }
    try {
        const dx = cx - mc.player.getX();
        const dy = cy - mc.player.getEyeY();
        const dz = cz - mc.player.getZ();
        const dh = Math.sqrt(dx * dx + dz * dz);
        const wantYaw = wrapDeg(Math.atan2(dz, dx) * 180 / Math.PI - 90);
        const wantPitch = wrapDeg(-(Math.atan2(dy, dh) * 180 / Math.PI));
        const dyaw = Math.abs(wrapDeg(wantYaw - mc.player.getYRot()));
        const dpitch = Math.abs(wrapDeg(wantPitch - mc.player.getXRot()));
        return dyaw < 10 && dpitch < 10;
    } catch (e) { return false; }
}

// oyuncuya bakan yuz (sunucu dogrulamasi icin en dogru yuz)
function faceFor(s) {
    const dx = (s.bx + 0.5) - mc.player.getX();
    const dy = (s.by + 0.5) - mc.player.getEyeY();
    const dz = (s.bz + 0.5) - mc.player.getZ();
    const ax = Math.abs(dx), ay = Math.abs(dy), az = Math.abs(dz);
    if (ay >= ax && ay >= az) return dy > 0 ? Direction.DOWN : Direction.UP;
    if (ax >= az) return dx > 0 ? Direction.WEST : Direction.EAST;
    return dz > 0 ? Direction.NORTH : Direction.SOUTH;
}

function blockAt(s) {
    return mc.level.getBlockState(new BlockPos(s.bx, s.by, s.bz));
}

// ulasilamiyor teshisi: 3 basarisiz denemeden sonra 1 kez soyle.
// (sebep cogu zaman kapali yol + allowBreak=false olur)
function checkFail() {
    if (failN < 3 || toldFail) return;
    toldFail = true;
    let d = "";
    try {
        const s = STS[st];
        const dx = (s.gx + 0.5) - mc.player.getX();
        const dy = (s.gy + 0.5) - mc.player.getY();
        const dz = (s.gz + 0.5) - mc.player.getZ();
        d = " (" + Math.sqrt(dx * dx + dy * dy + dz * dz).toFixed(1) + " blok)";
    } catch (e) { /* yoksay */ }
    msg("istasyon " + (st + 1) + " ulasilamiyor" + d + " - yol kapali olabilir (allowBreak kapaliysa kirarak gecemez)");
}

/* ================= Fazlar ================= */

function enterGoto(i) {
    st = i;
    phase = "goto";
    goalSet = false;
    failN = 0;
    toldFail = false;
    jumpOff();
    try { mc.gameMode.stopDestroyBlock(); } catch (e) { /* yoksay */ }
}

function enterMine(i) {
    st = i;
    phase = "mine";
    goalSet = false;
    failN = 0;
    toldFail = false;
    try { btCancel(); } catch (e) { /* yoksay */ }
    try { mc.gameMode.stopDestroyBlock(); } catch (e) { /* yoksay */ }
    jumpOff();
    rotWait = 3; // rotasyon paketi sunucuya gitsin, sonra kir
    lastJump = tickN;
}

function doGoto(s) {
    if (!btMode) {
        if (tickN % 50 === 0) {
            if (baritoneReady()) goalSet = false;
            else if (!toldNoBt) { toldNoBt = true; msg("baritone bulunamadi - mod listesinden Baritone'yu ac"); }
        }
        return;
    }
    toldNoBt = false;
    if (!goalSet) {
        try {
            btSetGoal(s.gx, s.gy, s.gz);
        } catch (e) {
            errOnce("baritone", e);
            return;
        }
        goalSet = true;
        gotoT = tickN;
        still = 0;
        try {
            lx = mc.player.getX(); ly = mc.player.getY(); lz = mc.player.getZ();
        } catch (e) { /* yoksay */ }
        return;
    }
    let dist = 99;
    try {
        const dx = (s.gx + 0.5) - mc.player.getX();
        const dy = (s.gy + 0.5) - mc.player.getY();
        const dz = (s.gz + 0.5) - mc.player.getZ();
        dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    } catch (e) { /* yoksay */ }
    if (dist < 1.5) { enterMine(st); return; }
    // timeout (30 sn): hedefi tazele
    if (tickN - gotoT > 600) { goalSet = false; failN++; checkFail(); return; }
    // takilma: 10 tick'te bir konum karsilastir
    if (tickN % 10 === 0) {
        try {
            const px = mc.player.getX(), py = mc.player.getY(), pz = mc.player.getZ();
            const mv = Math.abs(px - lx) + Math.abs(py - ly) + Math.abs(pz - lz);
            lx = px; ly = py; lz = pz;
            if (mv < 0.1) {
                still += 10;
                if (still >= 200) { still = 0; goalSet = false; failN++; checkFail(); }
            } else {
                still = 0;
            }
        } catch (e) { /* yoksay */ }
    }
}

function doMine(s) {
    let bedrock = false, air = false;
    try {
        const bs = blockAt(s);
        bedrock = bs.is(Blocks.BEDROCK);
        air = bs.isAir();
    } catch (e) {
        errOnce("block", e);
        return;
    }
    // bedrock -> sonraki istasyon (3. ise basa don)
    if (bedrock) { enterGoto((st + 1) % STS.length); return; }
    // kazma yok/tasiniyor -> vurma (elle kirma yok)
    if (!ensurePick()) return;
    // bak, bakis oturmadiysa kirma
    const ok = aimAt(s);
    if (rotWait > 0) { rotWait--; return; }
    if (!ok) return;
    // kir: hava ise no-op (blok respawn olunca kaldigi yerden devam),
    // ayni hedefte cagri guvenli (progress sifirlanmaz)
    try {
        mc.gameMode.continueDestroyBlock(new BlockPos(s.bx, s.by, s.bz), faceFor(s));
    } catch (e) {
        errOnce("break", e);
        return;
    }
    // kirarken her 8 sn'de bir zipla (hava beklerken degil)
    if (!air && tickN - lastJump >= 160) {
        lastJump = tickN;
        jumpPulse();
    }
}

/* ================= Kayit ================= */

script.registerModule({
    name: "AutoMetin",
    category: "Player",
    description: "3 istasyon: Baritone ile git, bloga bakarak kir (bedrock gorene kadar), basa don",
    settings: {
        goto1: Setting.text({ name: "1. Gitme Koordinati", default: "36 92 18" }),
        goto2: Setting.text({ name: "2. Gitme Koordinati", default: "53 92 2" }),
        goto3: Setting.text({ name: "3. Gitme Koordinati", default: "38 92 -16" }),
        messages: Setting.boolean({ name: "Mesajlar", default: true })
    }
}, (m) => {
    mod = m;

    mod.on("enable", () => {
        active = true;
        fatalFired = false;
        lastErrKey = "";
        tickN = 0;
        st = 0;
        phase = "goto";
        goalSet = false;
        gotoT = 0;
        still = 0;
        rotWait = 0;
        lastJump = 0;
        moveT = 0;
        toldNoPick = false;
        toldNoBt = false;
        toldCoord = false;
        failN = 0;
        toldFail = false;
        btMode = null;
        jumpOff();
        if (!baritoneReady() && !toldNoBt) {
            toldNoBt = true;
            msg("baritone bulunamadi - mod listesinden Baritone'yu ac");
        }
    });

    mod.on("disable", () => {
        active = false;
        cleanup();
    });

    mod.on("gameTick", () => {
        tickN++;
        if (jumpUntil > 0 && tickN >= jumpUntil) jumpOff();
        if (!active) return;
        try {
            if (!mc || !mc.player || !mc.level) return;
            STS = stations();
            const s = STS[st];
            if (phase === "mine") doMine(s);
            else doGoto(s);
        } catch (e) {
            fatal(e);
        }
    });
});

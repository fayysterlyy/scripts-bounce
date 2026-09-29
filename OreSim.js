// OreSim.js - LiquidBounce script (MC 1.21.11 worldgen, LiquidBounce 0.40.0 / MC 26.2 client)
// Seed tabanli vanilla ore dunya uretimi simulasyonu + ESP.
// RNG zinciri 1.21.11 vanilla ile birebir:
//   RandomSupport.upgradeSeedTo128bit -> Xoroshiro128++ -> BitRandomSource.nextLong (2x next(32))
//   setDecorationSeed(blockX, blockZ) -> setFeatureSeed(pop, index, step)
//   OreFeature/ScatteredOreFeature blob + canPlaceOre/shouldSkipAirCheck birebir port.
// Referanslar: vanilla OreFeature, BitRandomSource, WorldgenRandom (1.21.11 kaynagi),
// meteor-rejects OreSim/Ore, misode mcmeta placed_feature zincirleri.

const script = registerScript({
    name: "OreSim",
    version: "1.0.0",
    authors: ["kral"]
});

/* ================= Java bindings ================= */

const WGR = Java.type("net.minecraft.world.level.levelgen.WorldgenRandom");
const XRS = Java.type("net.minecraft.world.level.levelgen.XoroshiroRandomSource");
const AABB = Java.type("net.minecraft.world.phys.AABB");
const BlockPos = Java.type("net.minecraft.core.BlockPos");
const RSK = Java.type("net.ccbluex.liquidbounce.render.RenderShortcutsKt");
const HeightmapTypes = Java.type("net.minecraft.world.level.levelgen.Heightmap$Types");
const WGC = Java.type("net.minecraft.world.level.levelgen.WorldGenerationContext");
const ConstantInt = Java.type("net.minecraft.util.valueproviders.ConstantInt");
const ArrayListCls = Java.type("java.util.ArrayList");
const LongCls = Java.type("java.lang.Long");
const Modifier = Java.type("java.lang.reflect.Modifier");

let javaRnd = null;
try {
    const Alg = Java.type("net.minecraft.world.level.levelgen.WorldgenRandom$Algorithm");
    javaRnd = new WGR(Alg.XOROSHIRO.newInstance(0));
} catch (e) {
    javaRnd = new WGR(new XRS(0));
}

/* ================= JS BigInt RNG (1.21.11 vanilla birebir) ================= */

const U64 = (x) => BigInt.asUintN(64, x);
const S64 = (x) => BigInt.asIntN(64, x);
const GOLDEN = U64(-7046029254386353131n); // RandomSupport.GOLDEN_RATIO_64
const SILVER = 7640891576956012809n;       // RandomSupport.SILVER_RATIO_64

function rotl64(x, k) {
    x = U64(x);
    return U64((x << k) | (x >> (64n - k)));
}

// RandomSupport.mixStafford13
function mix13(z) {
    z = U64(z);
    z = U64(U64(z ^ (z >> 30n)) * 13787848793156543929n); // * -4658895280553007687L
    z = U64(U64(z ^ (z >> 27n)) * 10723151780598845931n);  // * -7723592293110705685L
    return U64(z ^ (z >> 31n));
}

// RandomSupport.upgradeSeedTo128bit
function initState(seed) {
    const low = U64(U64(seed) ^ SILVER);
    const high = U64(low + GOLDEN);
    return { lo: mix13(low), hi: mix13(high) };
}

// Xoroshiro128PlusPlus.nextLong (1.21.11)
function xorNext(st) {
    let s0 = st.lo;
    let s1 = st.hi;
    if ((s0 | s1) === 0n) {
        st.lo = GOLDEN;
        st.hi = SILVER;
        s0 = st.lo;
        s1 = st.hi;
    }
    const result = S64(rotl64(U64(s0 + s1), 17n) + s0);
    const nx = s0 ^ s1;
    st.lo = U64(rotl64(s0, 49n) ^ nx ^ U64(nx << 21n));
    st.hi = rotl64(nx, 28n);
    return result;
}

// WorldgenRandom.next(bits) = (int)(xoro.nextLong() >>> (64 - bits))
function wgrNext(st, bits) {
    return BigInt.asIntN(64, U64(xorNext(st)) >> BigInt(64 - bits));
}

// BitRandomSource.nextLong: int i = next(32); int j = next(32); return ((long)i << 32) + j;
function wgrNextLong(st) {
    const i = wgrNext(st, 32); // signed int
    const j = wgrNext(st, 32);
    return S64((i << 32n) + j);
}

// WorldgenRandom.setDecorationSeed -> Java long'a guvenli gecis (boxed Long)
function jlong(big) {
    return LongCls.valueOf(big.toString());
}

// WorldgenRandom.setDecorationSeed: setSeed(ws); nextLong|1 x2; blockX*i + blockZ*j ^ ws
function decorationSeed(worldSeed, blockX, blockZ) {
    const st = initState(worldSeed);
    const i = U64(wgrNextLong(st) | 1n);
    const j = U64(wgrNextLong(st) | 1n);
    return S64(U64(BigInt(blockX) * i + BigInt(blockZ) * j) ^ U64(worldSeed));
}

function setJavaSeed(big) {
    javaRnd.setSeed(jlong(big));
}

/* ================= RNG self-test ================= */

function rngSelfTest() {
    const probe = 1234567890123456789n;
    try {
        setJavaSeed(probe);
    } catch (e) {
        return "setSeed failed: " + e;
    }
    const st = initState(probe);
    for (let k = 0; k < 4; k++) {
        const jv = javaRnd.nextFloat();
        // BitRandomSource.nextFloat = next(24) * 5.9604645E-8F ; next(24) = xoro.nextLong >>> 40
        const bits24 = Number(U64(xorNext(st)) >> 40n);
        const jsv = Math.fround(bits24 * 5.9604645E-8);
        if (jv !== jsv) return "RNG mismatch: java=" + jv + " js=" + jsv;
    }
    // decorationSeed zinciri: Java setDecorationSeed vs JS (kayipsiz string karsilastirma)
    try {
        const ws = -8064503984169283406n;
        const bx = -112, bz = 240;
        const jvStr = LongCls.toString(javaRnd.setDecorationSeed(jlong(ws), bx, bz));
        const jsStr = decorationSeed(ws, bx, bz).toString();
        if (jvStr !== jsStr) return "decorationSeed mismatch: java=" + jvStr + " js=" + jsStr;
    } catch (e) {
        return "decorationSeed test failed: " + e;
    }
    return null;
}

/* ================= Mth.sin (26.2 LUT birebir JS portu) =================
   26.2'de Mth.sin client'ta invoke edilemiyor; vanilla LUT'unu birebir port:
   SIN[i] = (float)Math.sin(i / 10430.378350470453)
   sin(x) = SIN[(int)((long)(x * 10430.378350470453) & 65535L)]            */
const SIN_SCALE = 10430.378350470453;
let SIN_TABLE = null;
function mthSin(x) {
    if (SIN_TABLE === null) {
        SIN_TABLE = new Float64Array(65536);
        for (let i = 0; i < 65536; i++) {
            SIN_TABLE[i] = Math.fround(Math.sin(i / SIN_SCALE));
        }
    }
    // (long)(x * SCALE) & 65535 == JS ToInt32 alt 16 bit (mod 2^32 vs 2^64 alt16 bit ayni)
    return SIN_TABLE[((x * SIN_SCALE) | 0) & 65535];
}

/* ================= Renkler ================= */

const PALETTE = {
    coal: [70, 70, 70],
    iron: [236, 173, 119],
    gold: [247, 229, 30],
    redstone: [245, 7, 23],
    diamond: [33, 244, 255],
    lapis: [60, 90, 255],
    copper: [239, 151, 0],
    emerald: [27, 209, 45],
    quartz: [210, 210, 210],
    debris: [209, 27, 245]
};
const colorCache = {};
function colorFor(type) {
    if (!colorCache[type]) {
        const c = PALETTE[type] || [255, 255, 255];
        colorCache[type] = {
            outline: new Color4b(c[0], c[1], c[2], 230),
            fill: new Color4b(c[0], c[1], c[2], 70)
        };
    }
    return colorCache[type];
}

/* ================= Ore tanimlari (OrePlacements + genStep) ================= */

const ORE_DEFS = [
    ["ORE_COAL_LOWER", 6, "coal"], ["ORE_COAL_UPPER", 6, "coal"],
    ["ORE_IRON_MIDDLE", 6, "iron"], ["ORE_IRON_SMALL", 6, "iron"], ["ORE_IRON_UPPER", 6, "iron"],
    ["ORE_GOLD", 6, "gold"], ["ORE_GOLD_LOWER", 6, "gold"], ["ORE_GOLD_EXTRA", 6, "gold"],
    ["ORE_GOLD_NETHER", 7, "gold"], ["ORE_GOLD_DELTAS", 7, "gold"],
    ["ORE_REDSTONE", 6, "redstone"], ["ORE_REDSTONE_LOWER", 6, "redstone"],
    ["ORE_DIAMOND", 6, "diamond"], ["ORE_DIAMOND_BURIED", 6, "diamond"],
    ["ORE_DIAMOND_LARGE", 6, "diamond"], ["ORE_DIAMOND_MEDIUM", 6, "diamond"],
    ["ORE_LAPIS", 6, "lapis"], ["ORE_LAPIS_BURIED", 6, "lapis"],
    ["ORE_COPPER", 6, "copper"], ["ORE_COPPER_LARGE", 6, "copper"],
    ["ORE_EMERALD", 6, "emerald"],
    ["ORE_QUARTZ_NETHER", 7, "quartz"], ["ORE_QUARTZ_DELTAS", 7, "quartz"],
    ["ORE_ANCIENT_DEBRIS_SMALL", 7, "debris"], ["ORE_ANCIENT_DEBRIS_LARGE", 7, "debris"]
];

/* ================= Durum ================= */

let mod = null; // registerModule callback'inde atanir (tick/fatal/typeEnabled kullanir)
let active = false;
let ores = [];              // {loc,type,step,index,count,height,ctx,rarity,discard,size,scattered,targets}
let biomeOres = new Map();  // "minecraft:plains" -> Set(ore loc)
let regDim = null;
let worldSeed = null;       // BigInt
let cache = new Map();      // "cx,cz" -> { type: [x,y,z, ...] }
let lastAir = null;
let lastTypes = null;
let fatalFired = false;
let lastErrMsg = "";
let lastErrTime = 0;
let seedErrShown = false;
let sweepN = 0;

function chat(msg) {
    try { Client.displayChatMessage("OreSim: " + msg); } catch (e) { /* yoksay */ }
}

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
    if (lastErrMsg === m || now - lastErrTime < 3000) return;
    lastErrMsg = m;
    lastErrTime = now;
    chat(where + ": " + m);
}

/* ================= Registry kurulumu ================= */

function fieldByName(cls, name) {
    try {
        const fs = cls.getDeclaredFields();
        for (let i = 0; i < fs.length; i++) {
            if (fs[i].getName() === name) {
                try { fs[i].setAccessible(true); } catch (e2) { /* yoksay */ }
                return fs[i];
            }
        }
    } catch (e) { /* yoksay */ }
    return null;
}

// Placement instance'i icin alan sec: once adla, olmazsa static olmayan ilk alan
// (orn: RarityFilter'in ilk alani static MapCodec CODEC, instance alani "chance")
function pickField(m, name) {
    try {
        const fs = m.getClass().getDeclaredFields();
        let fallback = null;
        for (let i = 0; i < fs.length; i++) {
            const f = fs[i];
            try { f.setAccessible(true); } catch (e2) { /* yoksay */ }
            if (f.getName() === name) return f;
            if (fallback === null) {
                try {
                    if (!Modifier.isStatic(f.getModifiers())) fallback = f;
                } catch (e2) { /* yoksay */ }
            }
        }
        return fallback;
    } catch (e) {
        return null;
    }
}

// OreConfiguration.targetStates -> her RuleTest icin gercek hedef (TagKey/Block) veya "ALWAYS".
// null = hicbir hedef taninamadi -> fallback isAir.
// Not: 26.2'de SimpleBlockStateTest yok; TagMatchTest.field="tag", BlockMatchTest.field="block".
function parseTargets(cfg) {
    try {
        const list = cfg.targetStates;
        const out = [];
        const it = list.iterator();
        while (it.hasNext()) {
            const ts = it.next();
            const rf = fieldByName(ts.getClass(), "target"); // RuleTest
            if (!rf) continue;
            const rt = rf.get(ts);
            if (rt === null || rt === undefined) continue;
            const cn = rt.getClass().getSimpleName();
            if (cn === "AlwaysTrueTest") {
                out.push("ALWAYS");
                continue;
            }
            let f = fieldByName(rt.getClass(), "tag");
            if (!f) f = fieldByName(rt.getClass(), "block");
            if (!f) f = fieldByName(rt.getClass(), "state");
            if (!f) continue; // bilinmeyen rule test -> bu hedefi atla
            out.push(f.get(rt));
        }
        return out.length > 0 ? out : null;
    } catch (e) {
        return null;
    }
}

function matchesTarget(state, targets) {
    if (!targets) return !state.isAir(); // fallback: vanilla target.test yaklasikligi
    for (let i = 0; i < targets.length; i++) {
        const t = targets[i];
        if (t === "ALWAYS") return true;
        if (t === null || t === undefined) continue;
        try {
            if (state.is(t)) return true;
        } catch (e) {
            // overload/tag erisimi patlarsa: tastr/yaklasik, RNG'ye dokunmaz
            return !state.isAir();
        }
    }
    return false;
}

// OreConfiguration.targetStates -> yerine konulacak maden bloklari (Block).
// Dunya uretilmis geldigi icin: tag testi maden bloklarini reddeder; bu bloklar
// "pre-gen'de replaceable idi, feature koydu" anlamina gelir -> hedefi gecer sayilir.
function parsePlaceBlocks(cfg) {
    try {
        const list = cfg.targetStates;
        const out = [];
        const it = list.iterator();
        while (it.hasNext()) {
            const ts = it.next();
            const f = fieldByName(ts.getClass(), "state");
            if (!f) continue;
            const bs = f.get(ts);
            if (bs === null || bs === undefined) continue;
            const b = bs.getBlock();
            if (b) out.push(b);
        }
        return out.length > 0 ? out : null;
    } catch (e) {
        return null;
    }
}

function buildRegistry(dimId) {
    const VanillaRegistries = Java.type("net.minecraft.data.registries.VanillaRegistries");
    const Registries = Java.type("net.minecraft.core.registries.Registries");
    const WorldPresets = Java.type("net.minecraft.world.level.levelgen.presets.WorldPresets");
    const LevelStem = Java.type("net.minecraft.world.level.dimension.LevelStem");
    const FeatureSorter = Java.type("net.minecraft.world.level.biome.FeatureSorter");
    const OrePlacements = Java.type("net.minecraft.data.worldgen.placement.OrePlacements");

    const provider = VanillaRegistries.createLookup();
    const featureLookup = provider.lookupOrThrow(Registries.PLACED_FEATURE);
    const dims = provider.lookupOrThrow(Registries.WORLD_PRESET)
        .getOrThrow(WorldPresets.NORMAL).value()
        .createWorldDimensions().dimensions();

    let stemKey = LevelStem.OVERWORLD;
    if (dimId.indexOf("nether") >= 0) stemKey = LevelStem.NETHER;
    else if (dimId.indexOf("end") >= 0) stemKey = LevelStem.END;

    const stem = dims.get(stemKey);
    if (!stem) throw new Error("no LevelStem for " + dimId);

    const biomesColl = stem.generator().getBiomeSource().possibleBiomes();
    const biomeList = new ArrayListCls();
    const bit = biomesColl.iterator();
    while (bit.hasNext()) biomeList.add(bit.next());

    const indexer = FeatureSorter.buildFeaturesPerStep(
        biomeList,
        (entry) => entry.value().getGenerationSettings().features(),
        true
    );

    // vanilla: new WorldGenerationContext(generator, level) — height provider'lar
    // getMinGenY/getGenDepth icin generator kullanir (ctor ilk satirda getMinY cagirir)
    const hctx = new WGC(stem.generator(), mc.level);

    const newOres = [];
    const byLoc = {};
    for (const def of ORE_DEFS) {
        const field = def[0];
        const step = def[1];
        const type = def[2];
        let key;
        try { key = OrePlacements[field]; } catch (e) { continue; }
        if (!key) continue;
        let holder;
        try { holder = featureLookup.getOrThrow(key); } catch (e) { continue; }
        const pf = holder.value();
        const loc = String(key.identifier());

        let index;
        try { index = indexer.get(step).indexMapping().applyAsInt(pf); } catch (e) { continue; }

        const cf = pf.feature().value();
        const cfg = cf.config();
        if (!cfg || cfg.getClass().getName().indexOf("OreConfiguration") < 0) continue;
        const size = cfg.size;
        const discard = cfg.discardChanceOnAirExposure;
        const scattered = cf.feature().getClass().getName().indexOf("ScatteredOreFeature") >= 0;
        const targets = parseTargets(cfg);

        let countP = null;
        let heightP = null;
        let rarity = 1;
        const placement = pf.placement();
        for (let mi = 0; mi < placement.size(); mi++) {
            const m = placement.get(mi);
            const cn = m.getClass().getSimpleName();
            if (cn === "CountPlacement") {
                const f = pickField(m, "count");
                if (f) countP = f.get(m);
            } else if (cn === "HeightRangePlacement") {
                const f = pickField(m, "height");
                if (f) heightP = f.get(m);
            } else if (cn === "RarityFilter") {
                const f = pickField(m, "chance");
                if (f) rarity = f.getInt(m);
            }
            // in_square, biome -> RNG tuketmez / islenmez
        }
        if (!countP) countP = ConstantInt.of(1);
        if (!heightP) continue;

        const ore = {
            loc: loc, type: type, step: step, index: index,
            count: countP, height: heightP, ctx: hctx,
            rarity: rarity, discard: discard, size: size,
            scattered: scattered, targets: targets,
            placeBlocks: parsePlaceBlocks(cfg)
        };
        newOres.push(ore);
        byLoc[loc] = ore;
    }
    if (newOres.length === 0) throw new Error("no ore features registered");

    const newBiomeOres = new Map();
    for (let i = 0; i < biomeList.size(); i++) {
        const b = biomeList.get(i);
        const set = new Set();
        const feats = b.value().getGenerationSettings().features();
        for (let s = 0; s < feats.size(); s++) {
            const hs = feats.get(s);
            const arr = hs.stream().toArray();
            for (let k = 0; k < arr.length; k++) {
                const hk = arr[k].unwrapKey();
                if (!hk || !hk.isPresent()) continue;
                const fLoc = String(hk.get().identifier());
                if (byLoc[fLoc]) set.add(fLoc);
            }
        }
        const bk = b.unwrapKey();
        if (bk && bk.isPresent()) newBiomeOres.set(String(bk.get().identifier()), set);
    }

    ores = newOres;
    biomeOres = newBiomeOres;
    regDim = dimId;
}

/* ================= Vanilla OreFeature / canPlaceOre portu ================= */

const DIRS = [[0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0]];

function blockAt(world, x, y, z) {
    try {
        return world.getBlockState(new BlockPos(x, y, z));
    } catch (e) {
        return null;
    }
}

// OreFeature.isAdjacentToAir: komşulardan biri air mi
function isAdjacentToAir(world, x, y, z) {
    for (let d = 0; d < 6; d++) {
        const o = DIRS[d];
        const st = blockAt(world, x + o[0], y + o[1], z + o[2]);
        if (st !== null && st.isAir()) return true;
    }
    return false;
}

// OreFeature.canPlaceOre + shouldSkipAirCheck birebir (1.21.11)
// discard <= 0 -> place (RNG yok); discard >= 1 -> !isAdjacentToAir (RNG yok);
// arada -> nextFloat >= discard -> place, degilse !isAdjacentToAir
function shouldPlace(world, x, y, z, discard, airOn, rnd) {
    if (discard <= 0) return true;
    let skip = false;
    if (discard >= 1) {
        skip = false;
    } else {
        skip = rnd.nextFloat() >= discard; // vanilla nextFloat (kisa devre yok)
    }
    if (skip) return true;
    if (!airOn) return true; // air check kapali: RNG cekildi, karar atlandi
    return !isAdjacentToAir(world, x, y, z);
}

// state + target test (vanilla targetStates loop karsiligi)
// 1) tag/always test (pre-gen replaceable) OR
// 2) pozisyonda zaten bu feature'in maden blohu varsa (dunya uretilmis) -> pass
function stateOk(world, x, y, z, ore) {
    const st = blockAt(world, x, y, z);
    if (st === null) return false;
    if (matchesTarget(st, ore.targets)) return true;
    const pb = ore.placeBlocks;
    if (pb) {
        for (let i = 0; i < pb.length; i++) {
            try {
                if (st.is(pb[i])) return true;
            } catch (e) {
                try {
                    if (st.getBlock() === pb[i]) return true;
                } catch (e2) { /* yok say */ }
            }
        }
    }
    return false;
}

function generateNormal(world, rnd, ox, oy, oz, ore, airOn) {
    const veinSize = ore.size;
    const PI_F = Math.fround(Math.PI);
    const f = Math.fround(rnd.nextFloat() * PI_F);
    const g = veinSize / 8;
    const i = Math.ceil((veinSize / 16 * 2 + 1) / 2);

    const sinF = Math.sin(f);
    const cosF = Math.cos(f);
    const d = ox + sinF * g;   // startX
    const e = ox - sinF * g;   // endX
    const h = oz + cosF * g;   // startZ
    const j = oz - cosF * g;   // endZ
    const l = oy + rnd.nextInt(3) - 2; // startY
    const m = oy + rnd.nextInt(3) - 2; // endY

    const n = ox - Math.ceil(g) - i;
    const o = oy - 2 - i;
    const p = oz - Math.ceil(g) - i;
    const q = 2 * (Math.ceil(g) + i);
    const r = 2 * (2 + i);

    // vanilla heightmap: OCEAN_FLOOR_WG
    for (let s = n; s <= n + q; s++) {
        for (let t = p; t <= p + q; t++) {
            let hgt;
            try {
                hgt = world.getHeight(HeightmapTypes.OCEAN_FLOOR_WG, s, t);
            } catch (e2) {
                return null;
            }
            if (o <= hgt) {
                return generateVeinPart(world, rnd, veinSize, d, e, h, j, l, m, n, o, p, q, r, ore, airOn);
            }
        }
    }
    return null;
}

function generateVeinPart(world, rnd, veinSize, startX, endX, startZ, endZ, startY, endY,
                          x0, y0, z0, size, iSz, ore, airOn) {
    const poses = [];
    const total = size * iSz * size;
    if (total <= 0 || total > 1 << 22) return poses;
    const bit = new Uint8Array(total);
    const ds = new Float64Array(veinSize * 4);
    const PI_F = Math.fround(Math.PI);

    // segment uretimi (RNG: adet basina tek nextDouble)
    for (let n = 0; n < veinSize; n++) {
        const fp = Math.fround(n / veinSize);
        const pp = startX + fp * (endX - startX);
        const qq = startY + fp * (endY - startY);
        const rr = startZ + fp * (endZ - startZ);
        const ss = rnd.nextDouble() * veinSize / 16;
        const sinV = mthSin(Math.fround(PI_F * fp));
        const mm = (Math.fround(sinV + 1) * ss + 1) / 2;
        ds[n * 4] = pp;
        ds[n * 4 + 1] = qq;
        ds[n * 4 + 2] = rr;
        ds[n * 4 + 3] = mm;
    }

    // segment cull (RNG yok)
    for (let n = 0; n < veinSize - 1; n++) {
        if (!(ds[n * 4 + 3] > 0)) continue;
        for (let o = n + 1; o < veinSize; o++) {
            if (!(ds[o * 4 + 3] > 0)) continue;
            const pp = ds[n * 4] - ds[o * 4];
            const qq = ds[n * 4 + 1] - ds[o * 4 + 1];
            const rr = ds[n * 4 + 2] - ds[o * 4 + 2];
            const ss = ds[n * 4 + 3] - ds[o * 4 + 3];
            if (ss * ss > pp * pp + qq * qq + rr * rr) {
                if (ss > 0) ds[o * 4 + 3] = -1;
                else ds[n * 4 + 3] = -1;
            }
        }
    }

    for (let n = 0; n < veinSize; n++) {
        const u = ds[n * 4 + 3];
        if (u < 0) continue;
        const v = ds[n * 4];
        const w = ds[n * 4 + 1];
        const aa = ds[n * 4 + 2];
        const ab = Math.max(Math.floor(v - u), x0);
        const ac = Math.max(Math.floor(w - u), y0);
        const ad = Math.max(Math.floor(aa - u), z0);
        const ae = Math.max(Math.floor(v + u), ab);
        const af = Math.max(Math.floor(w + u), ac);
        const ag = Math.max(Math.floor(aa + u), ad);

        for (let ah = ab; ah <= ae; ah++) {
            const ai = (ah + 0.5 - v) / u;
            if (ai * ai >= 1) continue;
            for (let aj = ac; aj <= af; aj++) {
                const ak = (aj + 0.5 - w) / u;
                if (ai * ai + ak * ak >= 1) continue;
                for (let al = ad; al <= ag; al++) {
                    const am = (al + 0.5 - aa) / u;
                    if (ai * ai + ak * ak + am * am >= 1) continue;
                    // vanilla: sphere -> !isOutsideBuildHeight -> bitset
                    let outside = false;
                    try { outside = world.isOutsideBuildHeight(aj); } catch (e2) { outside = true; }
                    if (outside) continue;
                    const an = (ah - x0) + (aj - y0) * size + (al - z0) * size * iSz;
                    if (an < 0 || an >= bit.length || bit[an]) continue;
                    bit[an] = 1;
                    // target test (RNG yok): false ise shouldPlace'e girmeden atla (vanilla ayni)
                    if (!stateOk(world, ah, aj, al, ore)) continue;
                    if (shouldPlace(world, ah, aj, al, ore.discard, airOn, rnd)) {
                        poses.push(ah, aj, al);
                    }
                }
            }
        }
    }
    return poses;
}

// ScatteredOreFeature.getRandomPlacementInOneAxisRelativeToOrigin
function randomCoord(rnd, sz) {
    const diff = Math.fround(rnd.nextFloat() - rnd.nextFloat());
    const mul = Math.fround(diff * sz);
    return Math.floor(Math.fround(mul + 0.5)); // Math.round(float)
}

// ScatteredOreFeature.place portu
function generateHidden(world, rnd, ox, oy, oz, ore, airOn) {
    const poses = [];
    const veinSize = ore.size;
    const count = rnd.nextInt(veinSize + 1);
    for (let j = 0; j < count; j++) {
        const sz = Math.min(j, 7);
        const x = ox + randomCoord(rnd, sz);
        const y = oy + randomCoord(rnd, sz);
        const z = oz + randomCoord(rnd, sz);
        if (!stateOk(world, x, y, z, ore)) continue; // target.test
        if (shouldPlace(world, x, y, z, ore.discard, airOn, rnd)) {
            poses.push(x, y, z);
        }
    }
    return poses;
}

/* ================= Chunk simulasyonu ================= */

// Ayar okuma: key case-duyarsiz (config key'inin buyuk/kucuk harf hali garanti degil)
// + value alaninin tipi garanti degil; default'a dusme emniyetli.
function cfg(name, dflt) {
    try {
        if (mod !== null) {
            let s = mod.settings.get(name);
            if (s === null || s === undefined) {
                const it = mod.settings.entrySet().iterator();
                const want = String(name).toLowerCase();
                while (it.hasNext()) {
                    const e = it.next();
                    if (String(e.getKey()).toLowerCase() === want) {
                        s = e.getValue();
                        break;
                    }
                }
            }
            if (s !== null && s !== undefined) {
                const v = s.value;
                if (v !== undefined && v !== null) return v;
            }
        }
    } catch (e) { /* yoksay */ }
    return dflt;
}

function typeEnabled(type) {
    return !!cfg(type, false);
}

function simChunk(cx, cz) {
    const key = cx + "," + cz;
    if (cache.has(key)) return;
    const world = mc.level;
    if (!world || !world.hasChunk(cx, cz)) return;

    const out = {};
    try {
        const bx = cx * 16;
        const bz = cz * 16;
        const pop = decorationSeed(worldSeed, bx, bz);
        const airOn = !!cfg("airCheck", true);

        for (let oi = 0; oi < ores.length; oi++) {
            const ore = ores[oi];
            if (!typeEnabled(ore.type)) continue;

            // setFeatureSeed(pop, index, step) = setSeed(pop + index + 10000 * step)
            setJavaSeed(S64(pop + BigInt(ore.index) + 10000n * BigInt(ore.step)));
            const repeat = ore.count.sample(javaRnd);

            for (let i = 0; i < repeat; i++) {
                // RarityFilter: nextFloat() < 1.0F / chance
                if (ore.rarity !== 1 && javaRnd.nextFloat() >= Math.fround(1 / ore.rarity)) continue;

                // InSquarePlacement: x THEN z
                const x = javaRnd.nextInt(16) + bx;
                const z = javaRnd.nextInt(16) + bz;
                // HeightRangePlacement
                const y = ore.height.sample(javaRnd, ore.ctx);

                // BiomeFilter (pozisyon bazli, RNG yok)
                let allowed = true;
                try {
                    const bh = world.getBiome(new BlockPos(x, y, z));
                    const uk = bh.unwrapKey();
                    if (uk && uk.isPresent()) {
                        const set = biomeOres.get(String(uk.get().identifier()));
                        allowed = !!set && set.has(ore.loc);
                    }
                } catch (eb) { /* chunk disi: tahmin et */ }
                if (!allowed) continue;

                let poses;
                try {
                    if (ore.scattered) {
                        poses = generateHidden(world, javaRnd, x, y, z, ore, airOn);
                    } else {
                        poses = generateNormal(world, javaRnd, x, y, z, ore, airOn);
                    }
                } catch (eb) { poses = null; }

                if (poses && poses.length > 0) {
                    let arr = out[ore.type];
                    if (!arr) { arr = []; out[ore.type] = arr; }
                    for (let pi = 0; pi < poses.length; pi++) arr.push(poses[pi]);
                }
            }
        }
    } catch (e) {
        errOnce("sim " + key, e);
        return; // hata: cache'leme — sonraki tick'te tekrar dene
    }
    cache.set(key, out);
}

function evictFar(pcx, pcz, keep) {
    const gone = [];
    for (const key of cache.keys()) {
        const c = key.split(",");
        const dx = Math.abs(+c[0] - pcx);
        const dz = Math.abs(+c[1] - pcz);
        if (dx > keep || dz > keep) gone.push(key);
    }
    for (let i = 0; i < gone.length; i++) cache.delete(gone[i]);
}

function countBoxes() {
    let n = 0;
    for (const data of cache.values()) {
        for (const t in data) n += data[t].length / 3;
    }
    return n;
}

// AirCheck periyodik supurme: yaricap icindeki cache konumlarini kontrol et,
// blok hava olmussa (kazilmis) sil - Baritone olu hedefe yol cekmesin.
// Geri donen: silinen kutu sayisi.
function airSweep(px, py, pz, rad) {
    const R2 = rad * rad;
    const lvl = mc.level;
    if (!lvl) return 0;
    let removed = 0;
    for (const [key, data] of cache) {
        if (!data) continue;
        let dirty = false;
        for (const type in data) {
            const arr = data[type];
            for (let i = arr.length - 3; i >= 0; i -= 3) {
                const x = arr[i], y = arr[i + 1], z = arr[i + 2];
                const dx = x - px, dy = y - py, dz = z - pz;
                if (dx * dx + dy * dy + dz * dz > R2) continue;
                let air = false;
                try {
                    const st = blockAt(lvl, x, y, z);
                    air = st !== null && st.isAir();
                } catch (e) { /* yoksay */ }
                if (air) { arr.splice(i, 3); dirty = true; removed++; }
            }
        }
        if (dirty) {
            for (const type in data) {
                if (data[type].length === 0) delete data[type];
            }
            if (Object.keys(data).length === 0) cache.delete(key);
        }
    }
    return removed;
}

/* ================= Tick ================= */

function tick() {
    const world = mc.level;
    if (!world) return;

    // Seed
    const seedStr = String(cfg("seed", "-8064503984169283406")).trim();
    let parsed;
    try {
        parsed = BigInt(seedStr);
    } catch (e) {
        if (!seedErrShown) {
            seedErrShown = true;
            chat("gecersiz seed (sayi olmali): " + seedStr);
        }
        return;
    }
    seedErrShown = false;
    if (parsed !== worldSeed) {
        worldSeed = parsed;
        cache.clear();
        regDim = null;
    }

    // airCheck degistimi -> yeniden gorsel temizlik (RNG'yi etkilemez, sim yeniden)
    const air = !!cfg("airCheck", true);
    if (lastAir !== null && lastAir !== air) cache.clear();
    lastAir = air;

    // ore toggle degisimi -> cache yenile (hepsi default kapali, sonradan acilirsa diye)
    let typeSig = "";
    for (const d of ORE_DEFS) {
        const tp = d[2];
        if (typeEnabled(tp) && typeSig.indexOf("|" + tp) < 0) typeSig += "|" + tp;
    }
    if (lastTypes !== null && lastTypes !== typeSig) cache.clear();
    lastTypes = typeSig;

    // dimension / registry
    const dim = String(world.dimension().identifier());
    if (regDim !== dim || ores.length === 0) {
        buildRegistry(dim);
        cache.clear();
        chat("registry hazir: " + ores.length + " ore feature, dim: " + dim);
    }

    // RNG self-test (ilk tick)
    if (tick.tested !== true) {
        tick.tested = true;
        const err = rngSelfTest();
        if (err) {
            fatal("self-test", new Error(err));
            return;
        }
    }

    // AirCheck periyodik supurme: SweepTime saniyede bir, SweepRadius blok
    // yaricapindaki kazilmis (hava) konumlari cache'den sil
    if (air && mc.player) {
        sweepN++;
        const swEvery = Math.max(1, Math.floor(cfg("sweepTime", 10))) * 20;
        if (sweepN >= swEvery) {
            sweepN = 0;
            try {
                airSweep(mc.player.getX(), mc.player.getY(), mc.player.getZ(),
                    Math.max(1, Math.floor(cfg("sweepRadius", 10))));
            } catch (e) { errOnce("sweep", e); }
        }
    } else {
        sweepN = 0;
    }

    // Simulasyon kuyrugu (en yakin eksik chunk, butceli)
    const range = cfg("chunkRange", 5);
    const pcx = Math.floor(mc.player.getX() / 16);
    const pcz = Math.floor(mc.player.getZ() / 16);
    const budget = cfg("chunksPerTick", 3);
    const t0 = Date.now();
    let done = 0;

    outer:
    for (let r = 0; r <= range; r++) {
        for (let dx = -r; dx <= r; dx++) {
            for (let dz = -r; dz <= r; dz++) {
                if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
                const cx = pcx + dx;
                const cz = pcz + dz;
                if (cache.has(cx + "," + cz)) continue;
                if (!world.hasChunk(cx, cz)) continue;
                simChunk(cx, cz);
                done++;
                if (done >= budget || Date.now() - t0 >= 6) break outer;
            }
        }
    }

    evictFar(pcx, pcz, range + 3);

    tick.n = (tick.n || 0) + 1;
    if (tick.n % 20 === 0) {
        mod.tag = cache.size + "c / " + countBoxes() + "o";
    }
    // 5 sn sonra sim durumu ozeti (debug)
    if (tick.n === 100) {
        chat("sim: " + cache.size + " chunk / " + countBoxes() + " kutu");
    }
}

/* ================= Baritone hedefleme ================= */

const nav = { n: 0, x: 0, y: 0, z: 0, has: false, still: 0, lx: 0, ly: 0, lz: 0, black: {}, warnN: 0, members: null, gd: Infinity, gdTicks: 0, retry: 0 };
let btMode = null; // "direct" | "reflect"
let btErr = "";
let btIb = null, btGoalCls = null, btCgp = null, btPb = null; // direct mod
let btR = null; // reflect mod: { cgp, ctor, setM, pb, cancelM }

function btTryDirect() {
    const BA = Java.type("baritone.api.BaritoneAPI");
    btGoalCls = Java.type("baritone.api.pathing.goals.GoalBlock");
    btIb = BA.getProvider().getPrimaryBaritone();
    btCgp = btIb.getCustomGoalProcess();
    // cancelEverything IPathingBehavior'da, CustomGoalProcess'te DEGIL
    btPb = btIb.getPathingBehavior();
    btMode = "direct";
}

// classloader koprusu: Class.forName + reflection
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
    // cancelEverything CustomGoalProcess'te degil, PathingBehavior'da
    const pb = ib.getClass().getMethod("getPathingBehavior").invoke(ib);
    const cancelM = pb.getClass().getMethod("cancelEverything");
    // hepsi basarili -> ancak kaydet
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
    if (btMode === "direct") {
        if (btPb) btPb.cancelEverything();
        else btIb.getPathingBehavior().cancelEverything();
    } else if (btMode === "reflect") {
        btR.cancelM.invoke(btR.pb);
    }
}

function navStop() {
    if (nav.has) {
        try { btCancel(); } catch (e) { /* yoksay */ }
        nav.has = false;
        nav.still = 0;
    }
}

// acik toggle'lar + kara liste disindaki tum hesaplanmis konumlar
function collectPositions() {
    const out = [];
    for (const [key, data] of cache) {
        if (!data) continue;
        const c = key.split(",");
        const ox = +c[0] * 16, oz = +c[1] * 16;
        for (const type in data) {
            if (!typeEnabled(type)) continue;
            const arr = data[type];
            for (let i = 0; i < arr.length; i += 3) {
                const x = arr[i], y = arr[i + 1], z = arr[i + 2];
                if (nav.black[x + "," + y + "," + z]) continue;
                out.push({ k: x + "," + y + "," + z, x: x, y: y, z: z });
                if (out.length >= 10000) return out;
            }
        }
    }
    return out;
}

// kumeler: birbirine T bloktan yakin konumlar tek vein sayilir (DSU + grid)
function buildClusters(list) {
    const T = 4, T2 = T * T;
    const n = list.length;
    const parent = new Int32Array(n);
    for (let i = 0; i < n; i++) parent[i] = i;
    function find(a) {
        while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; }
        return a;
    }
    function union(a, b) {
        a = find(a); b = find(b);
        if (a !== b) parent[b] = a;
    }
    const grid = new Map();
    for (let i = 0; i < n; i++) {
        const p = list[i];
        const gk = Math.floor(p.x / T) + "," + Math.floor(p.y / T) + "," + Math.floor(p.z / T);
        let arr = grid.get(gk);
        if (!arr) { arr = []; grid.set(gk, arr); }
        arr.push(i);
    }
    for (let i = 0; i < n; i++) {
        const p = list[i];
        const gx = Math.floor(p.x / T), gy = Math.floor(p.y / T), gz = Math.floor(p.z / T);
        for (let ax = -1; ax <= 1; ax++) {
            for (let ay = -1; ay <= 1; ay++) {
                for (let az = -1; az <= 1; az++) {
                    const arr = grid.get((gx + ax) + "," + (gy + ay) + "," + (gz + az));
                    if (!arr) continue;
                    for (let m = 0; m < arr.length; m++) {
                        const j = arr[m];
                        if (j <= i) continue;
                        const q = list[j];
                        const dx = p.x - q.x, dy = p.y - q.y, dz = p.z - q.z;
                        if (dx * dx + dy * dy + dz * dz <= T2) union(i, j);
                    }
                }
            }
        }
    }
    const byRoot = new Map();
    for (let i = 0; i < n; i++) {
        const r = find(i);
        let g = byRoot.get(r);
        if (!g) { g = []; byRoot.set(r, g); }
        g.push(list[i]);
    }
    return Array.from(byRoot.values());
}

// takilma: once yolu iptal edip taze rota kur (baritone yeniden hesaplar),
// isimazsa kume silinip siradaki kumeye gecilir - durursa devam
function navStuck(cur) {
    if (nav.retry === 0) {
        nav.retry = 1;
        // iptal patlasa bile rota kurulsun (ayri try/catch)
        try {
            btCancel();
        } catch (e) {
            errOnce("baritone", e);
        }
        try {
            btSetGoal(nav.x, nav.y, nav.z);
        } catch (e) {
            errOnce("baritone", e);
        }
        nav.still = 0;
        nav.gd = Infinity;
        nav.gdTicks = 0;
        chat("yol takildi, yeniden rota kuruluyor");
    } else {
        for (const p of cur) nav.black[p.k] = true;
        navStop();
        nav.members = null;
        nav.retry = 0;
        chat("kume kitlenip gecildi: " + cur.length + " hedef");
    }
}

function navTick() {
    if (!active || !cfg("baritone", false)) { navStop(); return; }
    if (!mc.player || !mc.level) return;
    nav.n++;
    if (!btMode && (nav.n === 1 || nav.n % 50 === 0)) baritoneReady();
    if (!btMode) {
        nav.warnN++;
        if (nav.warnN === 8) {
            chat("baritone bulunamadi (" + btErr + ") - LiquidLauncher mod listesinden Baritone'yu ac");
        }
        return;
    }
    if (nav.n % 10 !== 0) return;

    const px = mc.player.getX(), py = mc.player.getY(), pz = mc.player.getZ();
    const list = collectPositions();
    if (list.length === 0) { navStop(); nav.members = null; return; }

    // mevcut kume hala var mi? (uyelerden en az biri duruyor mu)
    let cur = null;
    if (nav.members && nav.members.length > 0) {
        const have = new Map();
        for (const p of list) have.set(p.k, p);
        cur = [];
        for (const k of nav.members) {
            const p = have.get(k);
            if (p) cur.push(p);
        }
        if (cur.length === 0) cur = null;
    }

    // yoksa en yakin kumeyi sec ve uye anahtarlariyla kaydet (kume kimligi)
    if (!cur) {
        const clusters = buildClusters(list);
        if (clusters.length === 0) { navStop(); nav.members = null; return; }
        let best = null, bd = Infinity;
        for (const c of clusters) {
            let cd = Infinity;
            for (const p of c) {
                const dx = p.x + 0.5 - px, dy = p.y + 0.5 - py, dz = p.z + 0.5 - pz;
                const d = dx * dx + dy * dy + dz * dz;
                if (d < cd) cd = d;
            }
            if (cd < bd) { bd = cd; best = c; }
        }
        cur = best;
        nav.members = [];
        for (const p of cur) nav.members.push(p.k);
    }

    // kume ici en yakin, HAVA OLMAYAN uye = hedef
    // (kazilmis hedefe yol cekmesin; hepsi hava olmussa kume bitmistir)
    let t = null, td = Infinity;
    for (const p of cur) {
        let isAir = false;
        try {
            const st = blockAt(mc.level, p.x, p.y, p.z);
            isAir = st !== null && st.isAir();
        } catch (e) { /* yoksay */ }
        if (isAir) continue;
        const dx = p.x + 0.5 - px, dy = p.y + 0.5 - py, dz = p.z + 0.5 - pz;
        const d = dx * dx + dy * dy + dz * dz;
        if (d < td) { td = d; t = p; }
    }
    if (t === null) {
        for (const p of cur) nav.black[p.k] = true;
        nav.members = null;
        navStop();
        return;
    }

    if (!nav.has || t.x !== nav.x || t.y !== nav.y || t.z !== nav.z) {
        try {
            btSetGoal(t.x, t.y, t.z);
        } catch (e) {
            errOnce("baritone", e);
            navStop();
            return;
        }
        nav.x = t.x; nav.y = t.y; nav.z = t.z;
        nav.has = true;
        nav.still = 0;
        nav.gd = Infinity;
        nav.gdTicks = 0;
        nav.retry = 0;
        nav.lx = px; nav.ly = py; nav.lz = pz;
        return;
    }

    // hedefe mesafe ilerlemesi: yaklasmiyorsa sayaci buyut
    const gdx = nav.x + 0.5 - px, gdy = nav.y + 0.5 - py, gdz = nav.z + 0.5 - pz;
    const gd = gdx * gdx + gdy * gdy + gdz * gdz;
    if (gd < nav.gd - 4) { nav.gd = gd; nav.gdTicks = 0; } else { nav.gdTicks += 10; }
    if (nav.gdTicks >= 400) { navStuck(cur); return; }

    // ayni hedef: oyuncu hic hareket etmiyorsa takilmistir
    const mv = (px - nav.lx) * (px - nav.lx) + (py - nav.ly) * (py - nav.ly) + (pz - nav.lz) * (pz - nav.lz);
    nav.lx = px; nav.ly = py; nav.lz = pz;
    if (mv > 1) { nav.still = 0; return; }
    nav.still += 10;
    if (nav.still >= 200) navStuck(cur);
}

/* ================= Render ================= */

function render(ev) {
    const world = mc.level;
    if (!world || cache.size === 0) return;

    const env = ev.environment;
    const cam = ev.camera.position();
    const camX = cam.x, camY = cam.y, camZ = cam.z;
    const rd = cfg("renderDistance", 64);
    const rd2 = rd * rd;
    const maxB = cfg("maxBoxes", 3000);
    const fill = !!cfg("fill", false);
    const ps = env.poseStack;

    let drawn = 0;
    for (const [key, data] of cache) {
        if (drawn >= maxB) break;
        const c = key.split(",");
        const ox = +c[0] * 16;
        const oz = +c[1] * 16;
        if (data) {
            ps.pushPose();
            ps.translate(ox - camX, -camY, oz - camZ);
            for (const type in data) {
                if (drawn >= maxB) break;
                if (!typeEnabled(type)) continue;
                const arr = data[type];
                if (!arr || arr.length === 0) continue;
                const col = colorFor(type);
                const face = fill ? col.fill : null;
                for (let i = 0; i < arr.length; i += 3) {
                    if (drawn >= maxB) break;
                    const wx = arr[i], wy = arr[i + 1], wz = arr[i + 2];
                    const dx = wx + 0.5 - camX, dy = wy + 0.5 - camY, dz = wz + 0.5 - camZ;
                    if (dx * dx + dy * dy + dz * dz > rd2) continue;
                    const lx = wx - ox;
                    const lz = wz - oz;
                    RSK.drawBox(env, new AABB(lx, wy, lz, lx + 1, wy + 1, lz + 1),
                        face, col.outline, -1, -1, true);
                    drawn++;
                }
            }
            ps.popPose();
        }
    }
}

/* ================= Modul ================= */

script.registerModule({
    name: "OreSim",
    category: "Render",
    description: "Seed-based vanilla ore simulation ESP (1.21.11 worldgen)",
    settings: {
        seed: Setting.text({ name: "Seed", default: "-8064503984169283406" }),
        chunkRange: Setting.int({ name: "ChunkRange", default: 5, range: [1, 10] }),
        renderDistance: Setting.int({ name: "RenderDistance", default: 64, range: [16, 192], suffix: "m" }),
        maxBoxes: Setting.int({ name: "MaxBoxes", default: 3000, range: [100, 10000] }),
        chunksPerTick: Setting.int({ name: "ChunksPerTick", default: 3, range: [1, 10] }),
        airCheck: Setting.boolean({ name: "AirCheck", default: true }),
        sweepTime: Setting.int({ name: "SweepTime", default: 10, range: [2, 60], suffix: "sn" }),
        sweepRadius: Setting.int({ name: "SweepRadius", default: 10, range: [4, 32], suffix: "bl" }),
        fill: Setting.boolean({ name: "Fill", default: false }),
        baritone: Setting.boolean({ name: "Baritone", default: false }),
        coal: Setting.boolean({ name: "Coal", default: false }),
        iron: Setting.boolean({ name: "Iron", default: false }),
        gold: Setting.boolean({ name: "Gold", default: false }),
        redstone: Setting.boolean({ name: "Redstone", default: false }),
        diamond: Setting.boolean({ name: "Diamond", default: false }),
        lapis: Setting.boolean({ name: "Lapis", default: false }),
        copper: Setting.boolean({ name: "Copper", default: false }),
        emerald: Setting.boolean({ name: "Emerald", default: false }),
        quartz: Setting.boolean({ name: "Quartz", default: false }),
        debris: Setting.boolean({ name: "Debris", default: false })
    }
}, (m) => {
    mod = m;

    mod.on("enable", () => {
        active = true;
        fatalFired = false;
        cache.clear();
        regDim = null;
        tick.n = 0;
        tick.tested = false;
        sweepN = 0;
        nav.black = {};
        nav.members = null;
        nav.warnN = 0;
        chat("aktif. seed: " + cfg("seed", "-8064503984169283406"));
    });

    mod.on("disable", () => {
        active = false;
        cache.clear();
        navStop();
        nav.black = {};
        nav.members = null;
    });

    mod.on("worldChange", () => {
        cache.clear();
        regDim = null;
        ores = [];
        navStop();
        nav.black = {};
        nav.members = null;
    });

    mod.on("playerTick", () => {
        if (!active || !mc.player || !mc.level) return;
        try {
            tick();
        } catch (e) {
            fatal("tick", e);
        }
        try {
            navTick();
        } catch (e) {
            errOnce("nav", e);
        }
    });

    mod.on("blockChange", (ev) => {
        if (!active || !cfg("airCheck", true)) return;
        try {
            const st = ev.newState;
            if (!st.isAir()) return;
            const pos = ev.blockPos;
            const px = pos.getX(), py = pos.getY(), pz = pos.getZ();
            const data = cache.get((px >> 4) + "," + (pz >> 4));
            if (!data) return;
            for (const type in data) {
                const a = data[type];
                for (let i = 0; i < a.length; i += 3) {
                    if (a[i] === px && a[i + 1] === py && a[i + 2] === pz) {
                        a.splice(i, 3);
                        i -= 3;
                    }
                }
            }
        } catch (e) { /* sessiz */ }
    });

    mod.on("worldRender", (ev) => {
        if (!active) return;
        try {
            render(ev);
        } catch (e) {
            fatal("render", e);
        }
    });
});

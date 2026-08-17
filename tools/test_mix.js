/*
 * Pruebas de la mezcla de grados: cada hueco puede llevar el artefacto a un nivel y una rareza
 * distintos de los del resto. Se comprueba contra fuerza bruta sobre TODAS las versiones (no
 * sólo las que el optimizador se queda como candidatas), que mezclar nunca empeora el resultado
 * con el mismo presupuesto, que se respetan los topes y que «sin repetidos» sigue siendo por
 * artefacto y no por versión.
 *
 *   node tools/test_mix.js
 */
const fs = require('fs'), vm = require('vm');

const ctx = {window: {}, console, performance, setTimeout, Math, Date};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync('data/gamedata.js', 'utf8'), ctx);

const html = fs.readFileSync('index.html', 'utf8');
const grab = re => html.match(re)[0];
const D0 = ctx.window.SZ_DATA;

// Precios sintéticos deterministas: caros con el nivel y con la rareza, como los reales.
const FAKE = {region:'TEST', generated:'2026-01-01T00:00:00Z', demo:false,
  qclasses:['ordinary','unordinary','special','rare','exclusive','legendary','unique'],
  slopes:{artefact:[0.075, 1.369]}, items:{}};
let seed = 24680;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
for (const it of D0.artefacts){
  const base = 50000 + Math.floor(rnd() * 250000);
  const o = {};
  for (const [q, lvl] of [[0,0],[1,0],[1,15],[3,15]])
    o[`${q},${lvl}`] = [Math.round(base * Math.exp(0.075*lvl + 1.369*q)), 5 + Math.floor(rnd()*40)];
  FAKE.items[it.i] = {a: Math.log(base), b: 0.075, c: 1.369, n: 120, o};
}
ctx.window.SZ_PRICES = FAKE;
vm.runInContext(grab(/const ENGINE = \(\(\) => \{[\s\S]*?\n\}\)\(\);/) + '\n'
  + grab(/const OPTIMIZER = \(\(\) => \{[\s\S]*?\n\}\)\(\);/) + '\n'
  + grab(/const PRICES = \(\(\) => \{[\s\S]*?\n\}\)\(\);/)
  + '\n;globalThis.ENGINE=ENGINE;globalThis.OPTIMIZER=OPTIMIZER;globalThis.PRICES=PRICES;', ctx);
const D = ctx.window.SZ_DATA, E = ctx.ENGINE, O = ctx.OPTIMIZER, P = ctx.PRICES;

let fails = 0;
const check = (ok, msg) => { console.log((ok ? 'OK  ' : 'FALLO ') + msg); if (!ok) fails++; };
const priceOf = (id, lv, q) => { const e = P.estimate(id, lv, q); return e ? e.value : null; };

const cont = D.containers.find(c => c.cap === 3);
const armor = {item: D.armors.find(a => a.n.en.includes('Albatross Interceptor')), level: 15};
const subset = D.artefacts.slice(0, 18);
const base = {items: subset, container: cont, armor, level: 15, quality: 145, priceOf,
  maxCand: 999, timeLimit: 60000, bleeding: 0, burning: false, reactions: [], allowDup: true};

(async () => {
  // ---------- 1) Branch & bound vs fuerza bruta sobre todas las versiones ----------
  {
    const goals = ['__eh', 'speed_modifier', 'stamina_bonus'];
    const limitSets = [{}, {radiation_accumulation: 0.5, psycho_accumulation: 0.5}];
    let bad = 0, checks = 0, ejemplo = null;
    for (const goalId of goals) for (const limits of limitSets)
    for (const [mixLevel, mixQuality] of [[false, true], [true, false], [true, true]]){
      const p = {...base, goalId, limits, mixLevel, mixQuality, budget: 4e6};
      const r = await O.search(p);

      // Fuerza bruta: todas las combinaciones de todas las versiones permitidas.
      const C = O.context(p);
      const spec = O.goalSpec(goalId, []);
      const grid = O.grades(p);
      const vars = [];
      for (const it of subset) for (const g of grid){
        const cost = priceOf(it.i, g.level, g.quality);
        if (!(cost > 0) || cost > p.budget) continue;
        vars.push({v: O.artefactVector(it, g.level, g.quality, C.eff), cost});
      }
      const limEntries = Object.keys(limits).map(k => [O.IDX[k], limits[k]]);
      let brute = -Infinity;
      const raw = new Float64Array(O.KEYS.length);
      const rec = (start, depth, spent) => {
        const t = O.evaluate(raw, C);
        let ok = spent <= p.budget + 1e-9;
        if (ok) for (const [li, lim] of limEntries) if (t[li] > lim + 1e-9){ ok = false; break; }
        if (ok) brute = Math.max(brute, spec.f(t));
        if (depth >= cont.cap) return;
        for (let j = start; j < vars.length; j++){
          if (spent + vars[j].cost > p.budget + 1e-9) continue;
          for (let i = 0; i < raw.length; i++) raw[i] += vars[j].v[i];
          rec(j, depth + 1, spent + vars[j].cost);
          for (let i = 0; i < raw.length; i++) raw[i] -= vars[j].v[i];
        }
      };
      rec(0, 0, 0);

      checks++;
      const got = r.best ? r.best.value : -Infinity;
      if (!r.exhaustive || Math.abs(got - brute) > Math.max(1e-7, Math.abs(brute) * 1e-9)){
        bad++;
        console.log(`  FALLO ${goalId} lvl=${mixLevel} q=${mixQuality} lim=${!!limEntries.length}:`
          + ` B&B=${got} fuerza bruta=${brute} exh=${r.exhaustive}`);
      }
      if (!ejemplo && r.best) ejemplo = {goalId, vars: vars.length, cands: r.candidates};
    }
    check(!bad, `${checks} búsquedas con grados mezclados coinciden con la fuerza bruta`
      + ` (${ejemplo.vars} versiones reducidas a ${ejemplo.cands} candidatas)`);
  }

  // ---------- 2) Mezclar nunca empeora, y con presupuesto justo mejora ----------
  {
    const p = {...base, goalId: 'speed_modifier', limits: E.LIMITS, budget: 2.5e6};
    const fijo = await O.search({...p, mixLevel: false, mixQuality: false});
    const mixto = await O.search({...p, mixLevel: true, mixQuality: true});
    check(mixto.best.value >= fijo.best.value - 1e-9,
      `con el mismo tope de 2,5 M la mezcla no empeora: ${mixto.best.value.toFixed(2)}`
      + ` frente a ${fijo.best.value.toFixed(2)}`);
    check(mixto.best.value > fijo.best.value + 1e-9,
      `y aquí mejora de verdad, gastando ${(mixto.best.cost/1e6).toFixed(2)} M`
      + ` frente a ${(fijo.best.cost/1e6).toFixed(2)} M`);
    const grados = new Set(mixto.best.picks.map(pk => `${pk.level}/${pk.quality}`));
    check(grados.size > 1, `y usa grados distintos en la misma build: ${[...grados].join(', ')}`);
  }

  // ---------- 3) Los topes se respetan ----------
  {
    const p = {...base, goalId: '__eh', limits: {}, budget: 3e6, level: 9, quality: 130,
      mixLevel: true, mixQuality: true};
    const r = await O.search(p);
    const ok = r.best.picks.every(pk => pk.level <= 9 && pk.quality <= 130);
    check(ok, `ninguna pieza pasa del tope pedido (nivel ≤ 9, calidad ≤ 130 %): `
      + r.best.picks.map(pk => `+${pk.level}/${pk.quality}%`).join(' '));
    const clases = new Set(O.grades(p).map(g => P.qclass(g.quality)));
    check(!clases.has(3) && clases.has(2) && clases.has(0),
      'los grados generados llegan hasta la rareza pedida y no más (special sí, rare no)');
  }

  // ---------- 4) «Sin repetidos» es por artefacto, no por versión ----------
  {
    const p = {...base, goalId: 'speed_modifier', limits: {}, budget: 6e6,
      mixLevel: true, mixQuality: true, allowDup: false};
    const r = await O.search(p);
    const ids = r.best.picks.map(pk => pk.i);
    check(new Set(ids).size === ids.length,
      `sin repetidos no cuela el mismo artefacto en dos rarezas (${ids.length} piezas distintas)`);
    const conDup = await O.search({...p, allowDup: true});
    check(conDup.best.value >= r.best.value - 1e-9,
      `y permitirlos nunca da menos: ${conDup.best.value.toFixed(2)} ≥ ${r.best.value.toFixed(2)}`);
  }

  console.log(fails ? `\n${fails} comprobaciones fallidas` : '\n>>> MEZCLA DE GRADOS: todo correcto');
  if (fails) process.exitCode = 1;
})();

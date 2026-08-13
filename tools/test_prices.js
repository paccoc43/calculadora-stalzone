/*
 * Pruebas de la capa de precios: el estimador de PRICES y las dos extensiones del
 * optimizador (presupuesto máximo y objetivo por rublo), ambas contra fuerza bruta.
 *
 *   node tools/test_prices.js
 */
const fs = require('fs'), vm = require('vm');

// ---------- Instantánea de precios sintética, con casos límite deliberados ----------
// o["clase,nivel"] = [precio, ventas]
const FAKE = {
  region: 'TEST', generated: '2026-01-01T00:00:00Z', demo: false,
  qclasses: ['ordinary','unordinary','special','rare','exclusive','legendary','unique'],
  slopes: {artefact: [0.075, 1.369]},
  items: {},
};

const ctx = {window: {}, console, performance, setTimeout, Math, Date};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync('data/gamedata.js', 'utf8'), ctx);

const html = fs.readFileSync('index.html', 'utf8');
const grab = re => html.match(re)[0];
const eng = grab(/const ENGINE = \(\(\) => \{[\s\S]*?\n\}\)\(\);/);
const opt = grab(/const OPTIMIZER = \(\(\) => \{[\s\S]*?\n\}\)\(\);/);
const pri = grab(/const PRICES = \(\(\) => \{[\s\S]*?\n\}\)\(\);/);

const D = ctx.window.SZ_DATA;
// Precios inventados pero deterministas para todos los artefactos del catálogo.
let seed = 987654321;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
for (const it of D.artefacts){
  const base = 200000 + Math.floor(rnd() * 800000);
  const o = {};
  for (const [q, lvl] of [[0,0],[1,0],[1,15],[3,15]])
    o[`${q},${lvl}`] = [Math.round(base * Math.exp(0.075*lvl + 1.369*q)), 5 + Math.floor(rnd()*40)];
  FAKE.items[it.i] = {a: Math.log(base), b: 0.075, c: 1.369, n: 120, o};
}
// Un artefacto deliberadamente sin datos y otro con una única venta.
const NO_DATA = D.artefacts[3].i, THIN = D.artefacts[4].i;
delete FAKE.items[NO_DATA];
FAKE.items[THIN] = {a: Math.log(500000), b: 0.075, c: 1.369, n: 1, o: {'1,15': [500000, 1]}};

ctx.window.SZ_PRICES = FAKE;
vm.runInContext(eng + '\n' + opt + '\n' + pri +
  '\n;globalThis.ENGINE=ENGINE;globalThis.OPTIMIZER=OPTIMIZER;globalThis.PRICES=PRICES;', ctx);
const E = ctx.ENGINE, O = ctx.OPTIMIZER, P = ctx.PRICES;

let fails = 0;
const check = (ok, msg) => { console.log((ok ? 'OK  ' : 'FALLO ') + msg); if (!ok) fails++; };

// ---------- 1) Estimador ----------
const ref = D.artefacts[0].i;
const exact = P.estimate(ref, 15, 175);          // calidad 175 % → clase «legendary»… (5)
const known = P.estimate(ref, 15, 100);          // clase 1 (unordinary), nivel 15: observado
check(known.exact && known.value === FAKE.items[ref].o['1,15'][0],
  `observación directa: ${known.value.toLocaleString('es')} ₽ de ${known.n} ventas`);

const interp = P.estimate(ref, 7, 100);          // hueco entre (1,0) y (1,15)
const lo = FAKE.items[ref].o['1,0'][0], hi = FAKE.items[ref].o['1,15'][0];
check(!interp.exact && interp.value > lo && interp.value < hi,
  `nivel sin ventas se interpola dentro del rango: ${Math.round(interp.value).toLocaleString('es')} ₽`
  + ` (entre ${lo.toLocaleString('es')} y ${hi.toLocaleString('es')})`);

check(P.estimate(NO_DATA, 15, 175) === null, 'artefacto sin ventas registradas devuelve null');
check(!exact.exact && exact.value > hi, 'una calidad más alta que todo lo observado extrapola al alza');

const thin = P.estimate(THIN, 15, 100);
check(!thin.exact, 'una única venta no se da por exacta (n < 3), se suaviza');

// Monotonía: más nivel y más calidad nunca deben salir más baratos.
let mono = true;
for (let l = 0; l < 15; l++) if (P.estimate(ref, l, 100).value > P.estimate(ref, l+1, 100).value + 1e-6) mono = false;
for (const [q1, q2] of [[0,100],[100,115],[115,130],[130,145],[145,160],[160,175]])
  if (P.estimate(ref, 10, q1).value > P.estimate(ref, 10, q2).value + 1e-6) mono = false;
check(mono, 'el precio estimado crece de forma monótona con el nivel y con la rareza');

// ---------- 2) Presupuesto y por rublo vs fuerza bruta ----------
(async () => {
  const cont = D.containers.find(c => c.cap === 3);
  const armor = {item: D.armors.find(a => a.n.en.includes('Albatross Interceptor')), level: 15};
  const subset = D.artefacts.slice(0, 24);
  const level = 15, quality = 100;
  const costs = subset.map(it => { const e = P.estimate(it.i, level, quality); return e ? e.value : null; });

  // Presupuestos a escala de los precios en juego: uno que aprieta y otro holgado.
  const typical = costs.filter(c => c > 0).sort((a, b) => a - b)[Math.floor(costs.length / 2)];
  const goals = ['__eh', 'stamina_bonus', 'max_weight_bonus'];
  const budgets = [0, typical * 1.5, typical * 2.6];
  const limitSets = [{}, {radiation_accumulation: 0.5, psycho_accumulation: 0.5}];

  let checks = 0, bad = 0;
  for (const goalId of goals) for (const budget of budgets)
  for (const perCost of [false, true]) for (const limits of limitSets){
    if (!budget && !perCost) continue;                    // ya lo cubre test_engine.js
    const params = {items: subset, container: cont, armor, level, quality, goalId, limits,
      costs, budget, perCost, allowDup: true, maxCand: 999, timeLimit: 60000,
      bleeding: 0, burning: false, reactions: []};
    const r = await O.search(params);

    // Fuerza bruta sobre el mismo subconjunto, con las mismas reglas.
    const C = O.context(params);
    const spec = O.goalSpec(goalId, []);
    const usable = subset.map((it, i) => ({i, v: O.artefactVector(it, level, quality, C.eff), cost: costs[i]}))
                         .filter(s => s.cost > 0);
    const limEntries = Object.keys(limits).map(k => [O.IDX[k], limits[k]]);
    const base = spec.f(O.evaluate(new Float64Array(O.KEYS.length), C));
    // La build vacía es una opción válida salvo en modo por rublo (no tiene cociente).
    let bruteBest = perCost ? -Infinity : base;
    const raw = new Float64Array(O.KEYS.length);
    const rec = (start, depth, spent) => {
      if (depth > 0 && (!perCost || spent > 0)){
        const t = O.evaluate(raw, C);
        let ok = !(budget && spent > budget + 1e-9);
        if (ok) for (const [li, lim] of limEntries) if (t[li] > lim + 1e-9){ ok = false; break; }
        if (ok){
          const v = perCost ? (spec.f(t) - base) / spent : spec.f(t);
          if (v > bruteBest) bruteBest = v;
        }
      }
      if (depth >= cont.cap) return;
      for (let j = start; j < usable.length; j++){
        if (budget && spent + usable[j].cost > budget + 1e-9) continue;
        for (let i = 0; i < raw.length; i++) raw[i] += usable[j].v[i];
        rec(j, depth + 1, spent + usable[j].cost);
        for (let i = 0; i < raw.length; i++) raw[i] -= usable[j].v[i];
      }
    };
    rec(0, 0, 0);

    checks++;
    const got = r.best ? r.best.value : -Infinity;
    const ok = r.exhaustive && (
      (got === -Infinity && bruteBest === -Infinity) ||
      Math.abs(got - bruteBest) < Math.max(1e-7, Math.abs(bruteBest) * 1e-9));
    if (!ok){
      bad++;
      console.log(`  FALLO ${goalId} budget=${budget} perCost=${perCost} lim=${!!limEntries.length}:`
        + ` B&B=${got} fuerza bruta=${bruteBest} exh=${r.exhaustive}`);
    }
    // Y el presupuesto debe respetarse de verdad.
    if (budget && r.best){
      const spent = r.best.set.reduce((a, i) => a + costs[i], 0);
      if (spent > budget + 1e-6){ bad++; console.log(`  FALLO presupuesto excedido: ${spent} > ${budget}`); }
    }
  }
  check(!bad, `${checks} casos de presupuesto y por rublo: el branch & bound coincide con la fuerza bruta`);

  // ---------- 3) El presupuesto muerde de verdad ----------
  const bigCont = D.containers.find(c => c.cap === 5);
  const allCosts = D.artefacts.map(it => { const e = P.estimate(it.i, 15, 100); return e ? e.value : null; });
  const run = (budget, perCost) => O.search({items: D.artefacts, container: bigCont,
    armor, level: 15, quality: 100, goalId: '__eh', limits: {}, allowDup: true, maxCand: 40,
    timeLimit: 20000, bleeding: 0, burning: false, reactions: [], costs: allCosts, budget, perCost});
  const costOf = set => set.reduce((a, i) => a + (allCosts[i] || 0), 0);

  const libre = await run(0, false);
  const tope = costOf(libre.best.set) * 0.4;
  const corto = await run(tope, false);
  check(corto.best.value < libre.best.value && costOf(corto.best.set) <= tope + 1e-6,
    `con un tope de ${(tope/1e6).toFixed(1)} M ₽ la salud efectiva baja de ${libre.best.value.toFixed(0)}`
    + ` a ${corto.best.value.toFixed(0)} y el gasto de ${(costOf(libre.best.set)/1e6).toFixed(1)} M`
    + ` a ${(costOf(corto.best.set)/1e6).toFixed(1)} M`);

  // El modo por rublo tiene que ganar en rendimiento por rublo a la build más potente.
  const ctx2 = O.context({container: bigCont, armor, bleeding: 0, burning: false, reactions: []});
  const base2 = O.goalSpec('__eh', []).f(O.evaluate(new Float64Array(O.KEYS.length), ctx2));
  const ratio = await run(0, true);
  const rCost = costOf(ratio.best.set), lCost = costOf(libre.best.set);
  check(ratio.best.value >= (libre.best.value - base2) / lCost - 1e-12,
    `el modo por rublo rinde más por rublo que la build máxima`
    + ` (${(ratio.best.value*1e6).toFixed(1)} frente a ${((libre.best.value-base2)/lCost*1e6).toFixed(1)} por millón)`);
  check(rCost < lCost, `y sale más barata: ${(rCost/1e6).toFixed(1)} M frente a ${(lCost/1e6).toFixed(1)} M`);

  console.log(fails ? `\n${fails} comprobaciones fallidas` : '\n>>> PRECIOS: todo correcto');
  if (fails) process.exitCode = 1;
})();

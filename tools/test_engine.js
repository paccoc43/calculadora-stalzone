const fs = require('fs'), vm = require('vm');
const ctx = {window:{}, console, performance, setTimeout, Math, Date};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync('data/gamedata.js','utf8'), ctx);
const html = fs.readFileSync('index.html','utf8');
// Extrae los dos módulos puros del index.html
const eng = html.match(/const ENGINE = \(\(\) => \{[\s\S]*?\n\}\)\(\);/)[0];
const opt = html.match(/const OPTIMIZER = \(\(\) => \{[\s\S]*?\n\}\)\(\);/)[0];
vm.runInContext(eng + '\n' + opt + '\n;globalThis.ENGINE=ENGINE;globalThis.OPTIMIZER=OPTIMIZER;', ctx);
const D = ctx.window.SZ_DATA, E = ctx.ENGINE, O = ctx.OPTIMIZER;

// PRNG determinista
let seed = 12345;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const pick = a => a[Math.floor(rnd() * a.length)];

// ---------- 1) Cobertura de claves ----------
const allKeys = new Set();
for (const g of ['artefacts','containers','armors'])
  for (const it of D[g]) for (const s of it.s.concat(it.a || [])) allKeys.add(s[0]);
const missing = [...allKeys].filter(k => O.IDX[k] === undefined && !E.POLY.includes(k));
console.log(missing.length ? 'FALLO claves fuera del vector: ' + missing : 'OK  todas las claves cubiertas por el vector del optimizador');

// ---------- 2) OPTIMIZER.evaluate ≡ ENGINE.compute ----------
let worst = 0, worstCase = null, n = 0;
const REACTS = E.REACTIONS;
for (let t = 0; t < 4000; t++){
  const cont = pick(D.containers);
  const armor = rnd() < 0.85 ? {item: pick(D.armors), level: Math.floor(rnd()*16)} : null;
  const k = Math.floor(rnd() * (cont.cap + 1));
  const arts = [];
  for (let i = 0; i < k; i++){
    const it = pick(D.artefacts);
    const level = Math.floor(rnd()*16), quality = Math.floor(rnd()*191);
    arts.push({item: it, level, quality, addSel: it.a.map((_,x)=>x).slice(0, E.addSlots(it.i, level))});
  }
  const bleeding = Math.floor(rnd()*5), burning = rnd() < 0.3;
  const reactions = REACTS.filter(() => rnd() < 0.3);
  const build = {container: cont, armor, artefacts: arts, bleeding, burning, reactions};

  const ref = E.compute(build);
  const C = O.context(build);
  const raw = new Float64Array(O.KEYS.length);
  for (const a of arts){
    const v = O.artefactVector(a.item, a.level, a.quality, C.eff);
    for (let i = 0; i < raw.length; i++) raw[i] += v[i];
  }
  const t2 = O.evaluate(raw, C);

  const refMap = {};
  for (const s of ref.stats) refMap[s.key] = s.value;
  for (const key of O.KEYS){
    const a = refMap[key] || 0, b = t2[O.IDX[key]];
    const d = Math.abs(a - b);
    if (d > worst){ worst = d; worstCase = {key, a, b, t}; }
  }
  const d1 = Math.abs(ref.effectiveHealth - O.effectiveHealth(t2));
  const d2 = Math.abs(ref.healingPerSecond - O.healingPerSecond(t2));
  if (d1 > worst){ worst = d1; worstCase = {key:'effectiveHealth', a:ref.effectiveHealth, b:O.effectiveHealth(t2), t}; }
  if (d2 > worst){ worst = d2; worstCase = {key:'healingPerSecond', a:ref.healingPerSecond, b:O.healingPerSecond(t2), t}; }
  n++;
}
console.log(worst < 1e-9
  ? `OK  ${n} builds aleatorias: evaluate() ≡ compute() (desviación máx ${worst.toExponential(1)})`
  : `FALLO desviación ${worst} en ${JSON.stringify(worstCase)}`);

// ---------- 3) B&B vs fuerza bruta ----------
(async () => {
  const cont = D.containers.find(c => c.cap === 3);
  const armor = {item: D.armors.find(a => a.n.en.includes('Albatross Interceptor')), level: 15};
  const subset = D.artefacts.slice(0, 26);
  const goals = ['__eh', '__hps', 'stamina_bonus', 'max_weight_bonus', 'radiation_accumulation', 'stopping_protection'];
  const limitSets = [{}, {radiation_accumulation: 0.5, psycho_accumulation: 0.5, biological_accumulation: 0.5}];

  let fails = 0, checks = 0;
  for (const goalId of goals) for (const limits of limitSets) for (const allowDup of [true, false]){
    const params = {items: subset, container: cont, armor, level: 15, quality: 175, goalId, limits,
      allowDup, maxCand: 999, timeLimit: 60000, bleeding: 0, burning: false, reactions: []};
    const r = await O.search(params);

    // Fuerza bruta exhaustiva sobre el mismo subconjunto
    const C = O.context(params);
    const spec = O.goalSpec(goalId, []);
    const vecs = subset.map(it => O.artefactVector(it, 15, 175, C.eff));
    const limEntries = Object.keys(limits).map(k => [O.IDX[k], limits[k]]);
    let bruteBest = -Infinity, bruteSet = null;
    const raw = new Float64Array(O.KEYS.length);
    const rec = (start, depth) => {
      const t = O.evaluate(raw, C);
      let ok = true;
      for (const [li, lim] of limEntries) if (t[li] > lim + 1e-9){ ok = false; break; }
      if (ok){ const v = spec.f(t); if (v > bruteBest){ bruteBest = v; bruteSet = depth; } }
      if (depth >= cont.cap) return;
      for (let j = start; j < vecs.length; j++){
        for (let i = 0; i < raw.length; i++) raw[i] += vecs[j][i];
        rec(allowDup ? j : j + 1, depth + 1);
        for (let i = 0; i < raw.length; i++) raw[i] -= vecs[j][i];
      }
    };
    rec(0, 0);
    checks++;
    const got = r.best ? r.best.value : -Infinity;
    const ok = r.exhaustive && Math.abs(got - bruteBest) < 1e-7;
    if (!ok){ fails++; console.log(`  FALLO ${goalId} dup=${allowDup} lim=${!!limEntries.length}: B&B=${got} fuerza bruta=${bruteBest} exh=${r.exhaustive}`); }
  }
  console.log(fails ? `FALLO ${fails}/${checks} casos del optimizador` : `OK  ${checks} casos: el branch & bound encuentra el mismo óptimo que la fuerza bruta`);

  // ---------- 4) Rendimiento con el catálogo completo ----------
  const big = D.containers.find(c => c.cap === 7);
  const t0 = Date.now();
  const r = await O.search({items: D.artefacts, container: big, armor, level: 15, quality: 175,
    goalId: '__eh', limits: {radiation_accumulation:0.5, psycho_accumulation:0.5, biological_accumulation:0.5, thermal_accumulation:0.5, frost_accumulation:1},
    allowDup: true, maxCand: 34, timeLimit: 15000, bleeding: 0, burning: false, reactions: []});
  console.log(`OK  mochila de 7 huecos, objetivo Salud efectiva: ${r.best ? r.best.value.toFixed(2) : '—'} · ${r.nodes.toLocaleString('es')} nodos · ${((Date.now()-t0)/1000).toFixed(1)}s · ${r.exhaustive ? 'óptimo garantizado' : 'parcial'}`);
  if (r.best) console.log('    ->', r.best.set.map(i => D.artefacts[i].n.es).join(', '));
})();

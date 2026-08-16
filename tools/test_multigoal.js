/*
 * Pruebas del objetivo múltiple: varias estadísticas a la vez con un reparto de pesos.
 * Se comprueba que la media ponderada normalizada es la que dice ser, que el branch &
 * bound sigue encontrando el óptimo exacto (contra fuerza bruta) y que el reparto se
 * comporta: 100/0 equivale al objetivo suelto y un 50/50 no puede ser peor que quedarse
 * con el óptimo de una sola de las dos estadísticas.
 *
 *   node tools/test_multigoal.js
 */
const fs = require('fs'), vm = require('vm');
const ctx = {window: {}, console, performance, setTimeout, Math, Date};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync('data/gamedata.js', 'utf8'), ctx);

const html = fs.readFileSync('index.html', 'utf8');
const grab = re => html.match(re)[0];
vm.runInContext(grab(/const ENGINE = \(\(\) => \{[\s\S]*?\n\}\)\(\);/) + '\n'
  + grab(/const OPTIMIZER = \(\(\) => \{[\s\S]*?\n\}\)\(\);/)
  + '\n;globalThis.ENGINE=ENGINE;globalThis.OPTIMIZER=OPTIMIZER;', ctx);
const D = ctx.window.SZ_DATA, E = ctx.ENGINE, O = ctx.OPTIMIZER;

let fails = 0;
const check = (ok, msg) => { console.log((ok ? 'OK  ' : 'FALLO ') + msg); if (!ok) fails++; };
const min0 = (id, v) => E.CAN_BOTH.includes(id) ? -v : v;

const cont = D.containers.find(c => c.cap === 3);
const armor = {item: D.armors.find(a => a.n.en.includes('Albatross Interceptor')), level: 15};
const subset = D.artefacts.slice(0, 26);
const level = 15, quality = 175;
const params = {items: subset, container: cont, armor, level, quality, allowDup: true,
  maxCand: 999, timeLimit: 60000, bleeding: 0, burning: false, reactions: []};
const C = O.context(params);
const vecs = subset.map(it => O.artefactVector(it, level, quality, C.eff));
const emptyT = O.evaluate(new Float64Array(O.KEYS.length), C);

/** Escala de un objetivo = cuánto lo mejora, sobre la build vacía, perseguirlo él solo. */
async function calibrate(goalId, limits){
  const base = min0(goalId, O.goalSpec(goalId, []).f(emptyT));
  const r = await O.search({...params, goalId, limits: limits || {}});
  const top = r.best ? r.best.value : base;
  const scale = Math.abs(top - base) > 1e-9 ? Math.abs(top - base) : 1;
  return {base, scale, top};
}

(async () => {
  // ---------- 1) La media ponderada es exactamente eso ----------
  {
    const a = await calibrate('stamina_bonus'), b = await calibrate('max_weight_bonus');
    const parts = [{id:'stamina_bonus', weight:50, base:a.base, scale:a.scale},
                   {id:'max_weight_bonus', weight:30, base:b.base, scale:b.scale}];
    const spec = O.goalSpec(parts, []);
    const fa = O.goalSpec('stamina_bonus', []).f, fb = O.goalSpec('max_weight_bonus', []).f;
    let worst = 0;
    for (let t = 0; t < 300; t++){
      const raw = new Float64Array(O.KEYS.length);
      for (let k = 0; k < 3; k++){
        const v = vecs[Math.floor(Math.random() * vecs.length)];
        for (let i = 0; i < raw.length; i++) raw[i] += v[i];
      }
      const tv = O.evaluate(raw, C);
      const ref = (50 * (fa(tv) - a.base) / a.scale + 30 * (fb(tv) - b.base) / b.scale) / 80;
      worst = Math.max(worst, Math.abs(spec.f(tv) - ref));
    }
    check(worst < 1e-12, `la media ponderada 50/30 coincide con el cálculo directo (desv. máx ${worst.toExponential(1)})`);
    check(spec.comps.some(c => c[0] === 'stamina_bonus') && spec.comps.some(c => c[0] === 'max_weight_bonus'),
      'los componentes del objetivo compuesto son la unión de los de cada parte');
  }

  // ---------- 2) Branch & bound vs fuerza bruta ----------
  {
    const combos = [
      [['__eh', 50], ['stamina_bonus', 50]],
      [['speed_modifier', 70], ['stamina_regeneration_bonus', 30]],
      [['__hps', 50], ['max_weight_bonus', 25], ['stamina_bonus', 25]],
      [['health_bonus', 50], ['radiation_accumulation', 50]],   // una de las que van al revés
    ];
    const limitSets = [{}, {radiation_accumulation: 0.5, psycho_accumulation: 0.5}];
    let bad = 0, checks = 0;
    for (const combo of combos) for (const limits of limitSets){
      const parts = [];
      for (const [id, weight] of combo){
        const c = await calibrate(id, limits);
        parts.push({id, weight, base: c.base, scale: c.scale});
      }
      const r = await O.search({...params, goalId: parts, limits});

      const spec = O.goalSpec(parts, []);
      const limEntries = Object.keys(limits).map(k => [O.IDX[k], limits[k]]);
      let brute = -Infinity;
      const raw = new Float64Array(O.KEYS.length);
      const rec = (start, depth) => {
        const t = O.evaluate(raw, C);
        let ok = true;
        for (const [li, lim] of limEntries) if (t[li] > lim + 1e-9){ ok = false; break; }
        if (ok) brute = Math.max(brute, spec.f(t));
        if (depth >= cont.cap) return;
        for (let j = start; j < vecs.length; j++){
          for (let i = 0; i < raw.length; i++) raw[i] += vecs[j][i];
          rec(j, depth + 1);
          for (let i = 0; i < raw.length; i++) raw[i] -= vecs[j][i];
        }
      };
      rec(0, 0);
      checks++;
      const got = r.best ? r.best.value : -Infinity;
      if (!r.exhaustive || Math.abs(got - brute) > 1e-9){
        bad++;
        console.log(`  FALLO ${combo.map(c => c.join(':')).join(' + ')} lim=${!!limEntries.length}:`
          + ` B&B=${got} fuerza bruta=${brute} exh=${r.exhaustive}`);
      }
    }
    check(!bad, `${checks} objetivos compuestos: el branch & bound coincide con la fuerza bruta`);
  }

  // ---------- 3) El reparto se comporta ----------
  {
    // Dos estadísticas que sí compiten: los artefactos que más protegen frenan al personaje.
    const A = '__eh', B = 'speed_modifier';
    const ca = await calibrate(A), cb = await calibrate(B);
    const mk = (wa, wb) => [{id:A, weight:wa, base:ca.base, scale:ca.scale},
                            {id:B, weight:wb, base:cb.base, scale:cb.scale}];

    const solo = await O.search({...params, goalId: A, limits: {}});
    const todo = await O.search({...params, goalId: mk(100, 0), limits: {}});
    const valueOf = set => {
      const raw = new Float64Array(O.KEYS.length);
      for (const i of set) for (let k = 0; k < raw.length; k++) raw[k] += vecs[i][k];
      return O.evaluate(raw, C);
    };
    check(Math.abs(O.goalSpec(A, []).f(valueOf(todo.best.set)) - solo.best.value) < 1e-9,
      'un reparto 100/0 da el mismo resultado que perseguir esa estadística sola');

    const mitad = await O.search({...params, goalId: mk(50, 50), limits: {}});
    const spec = O.goalSpec(mk(50, 50), []);
    const soloB = await O.search({...params, goalId: B, limits: {}});
    const iA = spec.f(valueOf(solo.best.set)), iB = spec.f(valueOf(soloB.best.set));
    check(mitad.best.value >= Math.max(iA, iB) - 1e-9,
      `el 50/50 (${(mitad.best.value*100).toFixed(1)} %) no es peor que el óptimo de cada una`
      + ` (${(iA*100).toFixed(1)} % y ${(iB*100).toFixed(1)} %)`);

    const t50 = valueOf(mitad.best.set), tA = valueOf(solo.best.set);
    check(t50[O.IDX[B]] > tA[O.IDX[B]] + 1e-9 && O.effectiveHealth(t50) < O.effectiveHealth(tA) - 1e-9,
      `y llega a un compromiso: salud efectiva ${O.effectiveHealth(t50).toFixed(2)} frente a`
      + ` ${O.effectiveHealth(tA).toFixed(2)}, velocidad ${t50[O.IDX[B]].toFixed(2)} frente a ${tA[O.IDX[B]].toFixed(2)}`);
  }

  console.log(fails ? `\n${fails} comprobaciones fallidas` : '\n>>> OBJETIVO MÚLTIPLE: todo correcto');
  if (fails) process.exitCode = 1;
})();

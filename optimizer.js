/* =========================================================================
   OPTIMIZADOR
   ========================================================================= */
/**
 * Núcleo del optimizador. Sin dependencias del DOM para poder verificarlo aparte.
 *
 * Representa una build como un vector denso de contribuciones "crudas" de los artefactos
 * (que sí son aditivas) y aplica después, de una sola pasada, las transformaciones no
 * aditivas del motor: protección de la mochila, armadura, reacciones, estabilidad y
 * penalizaciones. Eso permite evaluar millones de combinaciones sin reconstruir objetos.
 *
 * La búsqueda es un branch & bound sobre combinaciones con (o sin) repetición. La cota
 * superior se calcula sustituyendo cada componente del objetivo por el mejor aporte que
 * queda disponible; como todas las transformaciones posteriores son monótonas crecientes
 * en esos componentes, la cota nunca subestima y la poda no puede descartar el óptimo.
 */
const OPTIMIZER = (() => {
  const KEYS = ENGINE.SORTED.filter(k => !ENGINE.POLY.includes(k));
  const IDX = Object.fromEntries(KEYS.map((k, i) => [k, i]));
  const N = KEYS.length;
  const vec = () => new Float64Array(N);

  /** Contribución cruda de un artefacto ya configurado. */
  function artefactVector(item, level, quality, eff){
    const v = vec();
    const addSel = item.a.map((_, k) => k).slice(0, ENGINE.addSlots(item.i, level));
    for (const s of ENGINE.artefactStats({item, level, quality, addSel}, eff)){
      const i = IDX[s.key];
      if (i !== undefined) v[i] += s.value;
    }
    return v;
  }

  /** Parte fija de la build (mochila, armadura, estado del personaje). */
  function context({container, armor, bleeding, burning, reactions}){
    const fixed = vec();
    if (armor && armor.item) for (const s of armor.item.s){
      const i = IDX[s[0]];
      if (i !== undefined) fixed[i] += ENGINE.armorValue(s, armor.level);
    }
    if (container) for (const s of container.s){
      const i = IDX[s[0]];
      if (i !== undefined) fixed[i] += s[1];
    }
    const bl = Math.max(0, Math.min(4, bleeding | 0));
    return {
      eff: container ? container.eff : 100,
      prot: container ? container.pro : 0,
      fixed,
      protIdx: ENGINE.CONT_PROTECT.map(k => IDX[k]).filter(i => i !== undefined),
      reactIdx: (reactions || []).map(k => IDX[k]).filter(i => i !== undefined),
      regPen: (ENGINE.BLEEDING_PENALTIES[bl][0] || 0) + (burning ? ENGINE.BURNING_PENALTIES.regeneration : 0),
      effPen: (ENGINE.BLEEDING_PENALTIES[bl][1] || 0) + (burning ? ENGINE.BURNING_PENALTIES.efficiency : 0),
    };
  }

  /** Aplica el resto del pipeline del motor sobre un vector crudo de artefactos. */
  function evaluate(raw, C, out){
    const t = out || vec();
    for (let i = 0; i < N; i++) t[i] = raw[i];
    if (C.prot) for (const i of C.protIdx) if (t[i] > 0) t[i] *= (1 - C.prot / 100);
    for (let i = 0; i < N; i++) t[i] += C.fixed[i];
    if (C.reactIdx.length){
      let bonus = 0;
      for (const i of C.reactIdx) bonus += t[i];
      t[IDX.health_bonus] += bonus;
      t[IDX.stamina_regeneration_bonus] += bonus;
    }
    const tear = t[IDX.tear_dmg_factor], stop = t[IDX.stopping_protection];
    if (tear !== 0 || stop !== 0) t[IDX.stopping_protection] = (1 - 100 / (100 + tear) * (1 - stop / 100)) * 100;
    if (C.regPen > 0) t[IDX.regeneration_bonus] -= C.regPen;
    if (C.effPen > 0) t[IDX.heal_efficiency] -= C.effPen;
    return t;
  }

  const effectiveHealth = t => (t[IDX.health_bonus] + 100) / 100 * (100 + t[IDX.bullet_dmg_factor]);
  const healingPerSecond = t => (t[IDX.regeneration_bonus] + 2.5) / 5 + t[IDX.artefakt_heal] * (1 + t[IDX.heal_efficiency] / 100);

  /**
   * Componentes de los que depende el objetivo y en qué dirección conviene moverlos.
   * dir = +1 → cuanto mayor, mejor; dir = -1 → cuanto menor, mejor.
   *
   * `goal` es un id suelto o una lista [{id, weight, base, scale}] para optimizar varias
   * estadísticas a la vez: cada una se mide como fracción de lo que se conseguiría
   * persiguiéndola sola —(f − base) / scale— y se promedian con los pesos dados. Sin esa
   * normalización un «50/50» compararía magnitudes de escalas distintas.
   */
  function goalSpec(goal, reactions){
    if (Array.isArray(goal)) return multiSpec(goal, reactions);
    const goalId = goal;
    const R = (reactions || []).filter(k => IDX[k] !== undefined);
    if (goalId === '__eh')
      return {comps: [...new Set(['health_bonus', 'bullet_dmg_factor', ...R])].map(k => [k, 1]), f: effectiveHealth};
    if (goalId === '__hps')
      return {comps: [['regeneration_bonus', 1], ['artefakt_heal', 1], ['heal_efficiency', 1]], f: healingPerSecond};
    if (goalId === 'stopping_protection')
      return {comps: [['tear_dmg_factor', 1], ['stopping_protection', 1]], f: t => t[IDX.stopping_protection]};
    const min = ENGINE.CAN_BOTH.includes(goalId);
    let comps = [[goalId, min ? -1 : 1]];
    if ((goalId === 'health_bonus' || goalId === 'stamina_regeneration_bonus') && R.length)
      comps = comps.concat(R.map(k => [k, 1]));
    return {comps, f: t => min ? -t[IDX[goalId]] : t[IDX[goalId]]};
  }

  /**
   * Media ponderada de varios objetivos ya normalizados.
   *
   * Los componentes son la unión de los de cada parte: una misma clave siempre tira en la
   * misma dirección (la marca ENGINE.CAN_BOTH), así que la unión no puede contradecirse y
   * la cota del branch & bound —que empuja cada componente a su mejor valor posible— sigue
   * siendo superior: la media de funciones monótonas también es monótona.
   */
  function multiSpec(parts, reactions){
    const specs = parts.map(g => {
      const s = goalSpec(g.id, reactions);
      const w = g.weight > 0 ? g.weight : 0;
      return {f: s.f, comps: s.comps, w, base: g.base || 0, scale: g.scale > 0 ? g.scale : 1};
    });
    const wsum = specs.reduce((a, s) => a + s.w, 0) || 1;
    const comps = new Map();
    for (const s of specs) if (s.w > 0) for (const [k, d] of s.comps) comps.set(k, d);
    return {
      comps: [...comps].map(([k, d]) => [k, d]),
      f: t => {
        let v = 0;
        for (const s of specs) if (s.w > 0) v += s.w * (s.f(t) - s.base) / s.scale;
        return v / wsum;
      },
    };
  }

  /*
   * Tope de calidad de cada escalón de rareza. Dentro de un escalón el precio de subasta es
   * el mismo (se cotiza por rareza) pero la stat sigue creciendo, así que al mezclar grados
   * sólo interesa el extremo superior de cada uno.
   */
  const QUAL_STEPS = [0, 115, 130, 145, 160, 175, 190];
  const qrank = q => { const r = ENGINE.RIDX[ENGINE.rarityOf(q)]; return r === undefined ? -1 : r; };

  /** Grados (nivel + calidad) que puede tomar un artefacto: uno solo, o todos por debajo del tope. */
  function grades(p){
    const quals = p.mixQuality
      ? [...QUAL_STEPS.filter(q => qrank(q) < qrank(p.quality)), p.quality]
      : [p.quality];
    const levels = [];
    if (p.mixLevel) for (let l = 0; l <= p.level; l++) levels.push(l);
    else levels.push(p.level);
    const out = [];
    for (const level of levels) for (const quality of quals) out.push({level, quality});
    return out;
  }

  /**
   * Frente de Pareto: se queda con lo que nadie mejora a la vez en precio, en cada componente
   * del objetivo y en cada acumulación limitada. Al mezclar grados hay decenas de versiones del
   * mismo artefacto y casi todas son basura —la misma stat por más dinero—, pero descartarlas
   * por «aporta menos» tiraría justo las baratas que hacen falta para cuadrar el presupuesto.
   */
  function undominated(list, comps, accIdx){
    const out = [];
    for (const s of list.slice().sort((a, b) => (a.cost || 0) - (b.cost || 0) || b.gain - a.gain)){
      let dominated = false;
      for (const k of out){
        if ((k.cost || 0) > (s.cost || 0) + 1e-9) continue;
        let better = true;
        for (const [ci, d] of comps)
          if (d > 0 ? k.v[ci] < s.v[ci] - 1e-12 : k.v[ci] > s.v[ci] + 1e-12){ better = false; break; }
        if (better) for (const li of accIdx) if (k.v[li] > s.v[li] + 1e-12){ better = false; break; }
        if (better){ dominated = true; break; }
      }
      if (!dominated) out.push(s);
    }
    return out;
  }

  /**
   * @param p.items      artefactos disponibles (objetos de gamedata)
   * @param p.costs      coste de cada artefacto (mismo orden que items); null = sin datos
   * @param p.priceOf    (id, level, quality) → precio; obligatorio para mezclar grados con precio
   * @param p.mixLevel   permitir cualquier nivel hasta p.level, no sólo p.level
   * @param p.mixQuality permitir cualquier rareza hasta p.quality, no sólo p.quality
   * @param p.budget     presupuesto máximo para el conjunto de artefactos (0 = sin límite)
   * @param p.perCost    maximizar la ganancia por rublo en lugar de la ganancia absoluta
   * @param p.onProgress callback(nodes, elapsed) — puede devolver una promesa para ceder el hilo
   * @param p.isAborted  función que corta la búsqueda
   */
  async function search(p){
    const cap = p.container.cap;
    const C = context(p);
    const spec = goalSpec(p.goalId, p.reactions);
    const limits = p.limits || {};
    const limEntries = Object.keys(limits).filter(k => IDX[k] !== undefined).map(k => [IDX[k], limits[k]]);
    const budget = p.budget > 0 ? p.budget : 0;
    const perCost = !!p.perCost;
    const costs = p.costs || null;
    // Sin precio no se puede ni respetar un presupuesto ni medir el rendimiento por rublo:
    // esos artefactos quedan fuera de la búsqueda (se informa de cuántos son).
    const needCost = budget > 0 || perCost;

    const empty = vec();
    const baseGoal = spec.f(evaluate(empty, C));

    // Aporte individual de cada artefacto en cada grado, para ordenar y elegir candidatos.
    const compIdx = spec.comps.map(([k, d]) => [IDX[k], d]);
    const accIdx = limEntries.map(([li]) => li);
    const grid = grades(p);
    const mixing = grid.length > 1;
    let scored = [];
    for (const [i, it] of p.items.entries()){
      const forItem = grid.map(g => {
        const v = artefactVector(it, g.level, g.quality, C.eff);
        return {i, level: g.level, quality: g.quality, v,
                cost: p.priceOf ? p.priceOf(it.i, g.level, g.quality) : (costs ? costs[i] : null),
                gain: spec.f(evaluate(v, C)) - baseGoal};
      });
      // Se poda artefacto a artefacto antes de juntarlo todo: es lo que mantiene manejable
      // el catálogo cuando cada uno aporta hasta 96 versiones de sí mismo.
      scored = scored.concat(mixing
        ? undominated(needCost ? forItem.filter(s => s.cost > 0) : forItem, compIdx, accIdx)
        : forItem);
    }
    const priced = needCost ? scored.filter(s => s.cost > 0) : scored;
    const skipped = p.items.length - new Set(priced.map(s => s.i)).size;
    const afford = budget ? priced.filter(s => s.cost <= budget + 1e-9) : priced;

    // Candidatos = los que más aportan al objetivo + los mejores "purificadores" de cada límite.
    const useful = afford.filter(s => s.gain > 1e-12);
    const byGain = (a, b) => b.gain - a.gain;
    const pool = new Set();
    // El grado tope siempre entra: así el espacio de búsqueda contiene al del modo fijo y
    // activar la mezcla no puede empeorar el resultado con los mismos topes.
    (mixing ? useful.filter(s => s.level === p.level && s.quality === p.quality) : useful)
      .slice().sort(byGain).slice(0, p.maxCand).forEach(s => pool.add(s));
    /*
     * Mezclando grados, el pool se reparte por tramos de gasto. Ordenar por aporte llenaría
     * la lista de versiones máximas que no caben ni dos en el presupuesto, y ordenar por
     * rublo la llenaría de baratijas: lo que hace falta es saber, para cada nivel de gasto,
     * qué artefactos son los mejores a ese precio. Una versión por artefacto y tramo.
     */
    const techo = budget || useful.reduce((m, s) => Math.max(m, s.cost || 0), 0);
    if (mixing && techo > 0){
      const BANDS = 8, porBanda = Math.max(4, Math.ceil(p.maxCand / 3));
      for (let b = 1; b <= BANDS; b++){
        const lo = techo * (b - 1) / BANDS, hi = techo * b / BANDS;
        const enBanda = useful.filter(s => s.cost > lo && s.cost <= hi).sort(byGain);
        const vistos = new Set();
        let puestas = 0;
        // Primero una versión de cada artefacto, para que el tramo no lo copen dos o tres…
        for (const s of enBanda){
          if (puestas >= porBanda) break;
          if (vistos.has(s.i)) continue;
          vistos.add(s.i); pool.add(s); puestas++;
        }
        // …y con el cupo que sobre, las siguientes mejores aunque repitan artefacto.
        for (const s of enBanda){
          if (puestas >= porBanda) break;
          if (pool.has(s)) continue;
          pool.add(s); puestas++;
        }
      }
    } else if (mixing){
      useful.slice().sort(byGain).slice(0, p.maxCand).forEach(s => pool.add(s));
    }
    for (const [li] of limEntries){
      afford.slice().sort((a, b) => a.v[li] - b.v[li]).slice(0, 6)
        .filter(s => s.v[li] < 0).forEach(s => pool.add(s));
    }
    // Quedarse sin candidatos (presupuesto que no da ni para un artefacto) no es «sin solución»:
    // la build vacía sigue siendo válida y el bucle la registra igual, con M = 0.
    const cands = (mixing ? undominated([...pool], compIdx, accIdx) : [...pool])
      .sort((a, b) => b.gain - a.gain);

    const M = cands.length;
    // Sufijos: mejor aporte disponible a partir de cada índice (0 = dejar el hueco vacío).
    const sufComp = compIdx.map(([ci, d]) => {
      const a = new Float64Array(M + 1);
      for (let j = M - 1; j >= 0; j--) a[j] = d > 0 ? Math.max(a[j + 1], cands[j].v[ci]) : Math.min(a[j + 1], cands[j].v[ci]);
      return a;
    });
    const sufLim = limEntries.map(([li]) => {
      const a = new Float64Array(M + 1);
      for (let j = M - 1; j >= 0; j--) a[j] = Math.min(a[j + 1], cands[j].v[li]);
      return a;
    });

    const raw = vec(), probe = vec(), scratch = vec();
    const choice = new Int32Array(cap), cursor = new Int32Array(cap + 1);
    const used = new Int32Array(p.items.length);   // veces que está puesto cada artefacto
    let best = null, nodes = 0, exhaustive = true, cost = 0;
    const t0 = (typeof performance !== 'undefined' ? performance : Date).now();

    // Valor que se maximiza: la ganancia sobre la build vacía, por rublo si se pide.
    const score = (f) => perCost ? (f - baseGoal) / cost : f;

    const record = (depth) => {
      if (perCost && cost <= 0) return;              // la build vacía no tiene rendimiento
      const t = evaluate(raw, C, scratch);
      for (const [li, lim] of limEntries) if (t[li] > lim + 1e-9) return;
      const v = score(spec.f(t));
      if (!best || v > best.value)
        best = {value: v, cost, picks: Array.from(choice.subarray(0, depth))};
    };

    /**
     * ¿Merece la pena seguir explorando este nivel?
     *
     * Con objetivo por rublo la cota se divide por el coste ya comprometido: cualquier
     * extensión de esta rama cuesta al menos eso, así que el cociente no puede subir más.
     */
    const prune = (depth) => {
      const start = cursor[depth], slotsLeft = cap - depth;
      if (best && (!perCost || cost > 0)){
        for (let i = 0; i < N; i++) probe[i] = raw[i];
        for (let c = 0; c < compIdx.length; c++) probe[compIdx[c][0]] += sufComp[c][start] * slotsLeft;
        if (score(spec.f(evaluate(probe, C, scratch))) <= best.value + 1e-9) return true;
      }
      for (let c = 0; c < limEntries.length; c++){
        for (let i = 0; i < N; i++) probe[i] = raw[i];
        probe[limEntries[c][0]] += sufLim[c][start] * slotsLeft;
        const t = evaluate(probe, C, scratch);
        if (t[limEntries[c][0]] > limEntries[c][1] + 1e-6) return true;
      }
      return false;
    };

    cursor[0] = 0;
    record(0);                                  // la build vacía también es una opción válida
    let depth = 0, steps = 0, lastYield = 0;
    while (depth >= 0){
      // Se cuentan las vueltas del bucle, no sólo los artefactos colocados: con un presupuesto
      // muy justo casi todas las ramas se descartan sin llegar a contar como nodo, y el reloj
      // no llegaría a mirarse nunca.
      if (++steps % 20000 === 0){
        const elapsed = (typeof performance !== 'undefined' ? performance : Date).now() - t0;
        if (p.isAborted && p.isAborted()){ exhaustive = false; break; }
        if (elapsed > p.timeLimit){ exhaustive = false; break; }
        // Mirar el reloj es gratis; devolver el hilo al navegador no (cada await cuesta unos
        // milisegundos), así que se hace por tiempo transcurrido y no por vueltas del bucle.
        if (p.onProgress && elapsed - lastYield > 120){
          lastYield = elapsed;
          await p.onProgress(nodes, elapsed);
        }
      }
      if (depth >= cap || cursor[depth] >= M || prune(depth)){
        depth--;
        if (depth >= 0){
          const c = cands[choice[depth]];
          for (let i = 0; i < N; i++) raw[i] -= c.v[i];
          if (needCost) cost -= c.cost;
          used[c.i]--;
        }
        continue;
      }
      const j = cursor[depth]++;
      // «Sin repetidos» es por artefacto: dos grados del mismo tampoco valen.
      if (!p.allowDup && used[cands[j].i]) continue;
      // Lo que no cabe en el presupuesto se descarta sin explorar: añadir sólo encarece.
      if (budget && cost + cands[j].cost > budget + 1e-9) continue;
      choice[depth] = j;
      const v = cands[j].v;
      for (let i = 0; i < N; i++) raw[i] += v[i];
      if (needCost) cost += cands[j].cost;
      used[cands[j].i]++;
      nodes++;
      record(depth + 1);
      cursor[depth + 1] = p.allowDup ? j : j + 1;
      depth++;
    }

    const elapsed = (typeof performance !== 'undefined' ? performance : Date).now() - t0;
    return {
      best: best ? {
        value: best.value, cost: best.cost,
        set: best.picks.map(k => cands[k].i),
        // Cada pieza con el grado en el que se ha elegido: sin mezclar son todas iguales.
        picks: best.picks.map(k => ({i: cands[k].i, level: cands[k].level, quality: cands[k].quality,
                                     cost: cands[k].cost})),
      } : null,
      nodes, exhaustive, candidates: M, elapsed, skipped, mixed: mixing,
    };
  }

  return {search, evaluate, context, artefactVector, goalSpec, grades, effectiveHealth, healingPerSecond, KEYS, IDX};
})();

/* =========================================================================
   MOTOR DE CÁLCULO
   Réplica exacta de la lógica de la calculadora oficial de stalzone.wiki.
   Verificado contra una build de referencia: 26/26 estadísticas idénticas.
   ========================================================================= */
const ENGINE = (() => {
  const ACC = ['radiation_accumulation','biological_accumulation','psycho_accumulation','thermal_accumulation','frost_accumulation'];
  // Acumulaciones que la protección de la mochila puede mitigar (la congelación no).
  const CONT_PROTECT = ['radiation_accumulation','biological_accumulation','psycho_accumulation','thermal_accumulation'];
  // Stats donde un valor negativo es lo bueno (acumulaciones, retroceso, oscilación).
  const CAN_BOTH = [...ACC,'bleeding_accumulation','combustion_accumulation','recoil_bonus','wiggle_bonus'];
  const POLY = ['cost','recharge','blocking_damage','trigger_damage'];
  const REACTIONS = ['reaction_to_tear','reaction_to_electroshock','reaction_to_chemical_burn','reaction_to_burn'];
  // Umbrales a partir de los cuales el personaje empieza a recibir daño.
  const LIMITS = {radiation_accumulation:.5, biological_accumulation:.5, psycho_accumulation:.5, thermal_accumulation:.5, frost_accumulation:1};
  const BLEEDING_PENALTIES = [[0,0],[2.5,30],[17.5,80],[27.5,130],[37.5,180]];
  const BURNING_PENALTIES = {regeneration:5, efficiency:65};
  const RIDX = {'rarity.unordinary':0,'rarity.special':1,'rarity.rare':2,'rarity.exclusive':3,'rarity.legendary':4,'rarity.unique':5};
  const RUBIK = '9n7z'; // único artefacto con un 4.º hueco de stat adicional (desde nivel 1)

  const SORTED = ['bleeding_accumulation','combustion_accumulation','artefakt_heal','bullet_dmg_factor','health_bonus',
    'heal_efficiency','regeneration_bonus','speed_modifier','sprint_speed_modifier','stamina_bonus','stamina_regeneration_bonus',
    'max_weight_bonus','recoil_bonus','wiggle_bonus','tear_dmg_factor','stopping_protection','explosion_dmg_factor','burn_dmg_factor','electra_dmg_factor',
    'chemical_burn_dmg_factor','radiation_protection_short','radiation_protection','thermal_protection','biological_protection',
    'psycho_protection','frost_protection','bleeding_protection','reaction_to_electroshock','reaction_to_burn',
    'reaction_to_chemical_burn','reaction_to_tear','biological_accumulation','psycho_accumulation','thermal_accumulation',
    'radiation_accumulation','frost_accumulation','blocking_damage','recharge','cost','trigger_damage'];

  const CATEGORY = {
    health_bonus:'survivability', artefakt_heal:'survivability', regeneration_bonus:'survivability',
    heal_efficiency:'survivability', bleeding_accumulation:'survivability', combustion_accumulation:'accumulation',
    speed_modifier:'mobility', sprint_speed_modifier:'mobility', stamina_bonus:'mobility',
    stamina_regeneration_bonus:'mobility', max_weight_bonus:'mobility', recoil_bonus:'mobility', wiggle_bonus:'mobility',
    bullet_dmg_factor:'protection', tear_dmg_factor:'protection', stopping_protection:'protection',
    explosion_dmg_factor:'protection', burn_dmg_factor:'protection', chemical_burn_dmg_factor:'protection',
    electra_dmg_factor:'protection', radiation_protection:'protection', radiation_protection_short:'protection',
    biological_protection:'protection', psycho_protection:'protection', thermal_protection:'protection',
    frost_protection:'protection', bleeding_protection:'protection',
    radiation_accumulation:'accumulation', biological_accumulation:'accumulation', psycho_accumulation:'accumulation',
    thermal_accumulation:'accumulation', frost_accumulation:'accumulation',
    reaction_to_tear:'reactions', reaction_to_electroshock:'reactions', reaction_to_chemical_burn:'reactions', reaction_to_burn:'reactions',
    cost:'polyhedron', recharge:'polyhedron', blocking_damage:'polyhedron', trigger_damage:'polyhedron',
  };
  const CATEGORY_ORDER = ['survivability','mobility','protection','reactions','accumulation','polyhedron','other'];
  const CATEGORY_LABEL = {survivability:'Supervivencia', mobility:'Movilidad', protection:'Protección',
    reactions:'Reacciones a anomalías', accumulation:'Acumulación', polyhedron:'Poliedro', other:'Otros'};

  /** Rareza derivada del porcentaje de calidad (0–190). */
  function rarityOf(q){
    if (q >= 175.01 && q <= 190) return 'rarity.unique';
    if (q >= 160.01) return 'rarity.legendary';
    if (q >= 145.01) return 'rarity.exclusive';
    if (q >= 130.01) return 'rarity.rare';
    if (q >= 115.01) return 'rarity.special';
    if (q >= 100)    return 'rarity.unordinary';
    return 'rarity.ordinary';
  }

  /** Nº de huecos de stats adicionales desbloqueados por el nivel. */
  function addSlots(artId, level){
    let n = 0;
    if (artId === RUBIK && level >= 1) n++;
    if (level >= 5) n++;
    if (level >= 10) n++;
    if (level >= 15) n++;
    return n;
  }

  /**
   * Valor de una stat de artefacto (formato [clave, min, max, positiva, porcentaje]).
   * @param eff eficiencia de la mochila (las acumulaciones la ignoran).
   */
  function statValue(st, level, quality, rarity, eff){
    const key = st[0], vmin = st[1], vmax = st[2], positive = !!st[3];

    if (key === 'trigger_damage') return vmax;
    if (key === 'recharge' || key === 'blocking_damage' || key === 'cost'){
      let v = vmax < vmin ? vmin - (vmin - vmax) * (quality/100) * 0.8689 : vmax * (quality/100);
      const c = level > 0 ? 2*level : 0;
      if (c > 0) v = vmax > vmin ? v * (1 + c/100) : v / ((1 + c/100) * 1.1);
      return v;
    }

    const t = (ACC.includes(key) ? 100 : eff) / 100;
    let mx = Math.max(vmax, vmin), mn = Math.min(vmax, vmin);
    if (vmax <= 0 && vmin <= 0){ mx = Math.min(vmax, vmin); mn = Math.max(vmax, vmin); } // el "máximo" es el más negativo
    mx *= t; mn *= t;

    if (positive) return mx * (quality/100) * (1 + 2*level/100);

    // Stats negativas: el nivel no las mejora y saturan dentro de su franja de rareza.
    const d = quality;
    if (d <= 100){
      if (d === 100 && rarity === 'rarity.unordinary'){
        const a = 0.9 * mx;
        return a + (mx - a)/100 * ((d - (100 + 10*RIDX[rarity])) * 10);
      }
      return mn + (mx - mn)/100 * d;
    }
    const ri = RIDX[rarity];
    const fallback = Math.floor((d - 100)/15);
    let i = Math.max(0, Math.min(ri !== undefined ? ri : fallback, 5));
    if ([115,130,145,160,175,190].includes(d)) i = RIDX[rarity];
    const frac = Math.max(0, Math.min(d - (100 + 15*i), 15)) / 15;
    const lo = 0.85 * mx;
    return lo + (mx - lo) * frac;
  }

  /** Stats activas de un artefacto configurado (base + adicionales desbloqueadas y elegidas). */
  function artefactStats(cfg, eff){
    const item = cfg.item;
    const rarity = rarityOf(cfg.quality);
    const slots = addSlots(item.i, cfg.level);
    const chosen = (cfg.addSel || []).filter(i => i < item.a.length).slice(0, slots);
    const list = item.s.concat(chosen.map(i => item.a[i]));
    return list.map(st => ({
      key: st[0], pct: !!st[4], origin: 'artefact',
      value: statValue(st, cfg.level, cfg.quality, rarity, eff),
    }));
  }

  const isPositive = (key, sum) => CAN_BOTH.includes(key) ? sum <= 0 : sum > 0;

  function merge(stats){
    const m = new Map();
    for (const s of stats){
      const cur = m.get(s.key);
      if (cur) cur.value += s.value;
      else m.set(s.key, {key:s.key, pct:s.pct, origin:s.origin, value:s.value});
    }
    for (const s of m.values()) s.positive = isPositive(s.key, s.value);
    return [...m.values()];
  }

  const armorValue = (s, lvl) => s.length > 4 ? s[4][Math.min(lvl, s[4].length - 1)] : s[1];

  /**
   * Calcula una build completa.
   * build = {container, containerItem, armor:{item,level}, artefacts:[cfg], bleeding, burning, reactions:[keys]}
   */
  function compute(build){
    const cont = build.container;                       // objeto de gamedata o null
    const eff  = cont ? cont.eff : 100;
    const prot = cont ? cont.pro : 0;

    // 1) Artefactos: se calculan y se suman entre sí.
    const artStats = [];
    for (const cfg of build.artefacts) if (cfg && cfg.item) artStats.push(...artefactStats(cfg, eff));

    const polyStats = merge(artStats.filter(s => POLY.includes(s.key)));
    let summed = merge(artStats.filter(s => !POLY.includes(s.key)));

    // 2) La protección de la mochila mitiga las acumulaciones dañinas del conjunto de artefactos.
    for (const s of summed){
      if (!s.positive && CONT_PROTECT.includes(s.key)) s.value *= (1 - prot/100);
    }

    // 3) Se añaden armadura y mochila (no reciben protección ni eficiencia).
    const all = summed.slice();
    if (build.armor && build.armor.item)
      for (const s of build.armor.item.s)
        all.push({key:s[0], value:armorValue(s, build.armor.level), pct:!!s[3], origin:'armor'});
    if (cont)
      for (const s of cont.s)
        all.push({key:s[0], value:s[1], pct:!!s[3], origin:'container'});

    let out = merge(all);

    // 4) Bonus de reacción: las reacciones activas suman a vitalidad y regeneración de aguante.
    const bonus = (build.reactions || []).reduce((acc,k) => {
      const st = out.find(s => s.key === k);
      return acc + (st ? st.value : 0);
    }, 0);
    if (bonus !== 0){
      for (const k of ['health_bonus','stamina_regeneration_bonus']){
        const st = out.find(s => s.key === k);
        if (st){ st.value += bonus; st.positive = isPositive(k, st.value); }
        else out.push({key:k, value:bonus, pct:true, origin:'reaction', positive:bonus > 0});
      }
    }

    // 5) Estabilidad: combinación no lineal de laceración y estabilidad.
    const get = k => out.find(s => s.key === k);
    const tear = get('tear_dmg_factor'), stop = get('stopping_protection');
    const n = tear ? tear.value : 0, i = stop ? stop.value : 0;
    if (n !== 0 || i !== 0){
      const v = (1 - 100/(100 + n) * (1 - i/100)) * 100;
      if (stop){ stop.value = v; stop.positive = v > 0; }
      else out.push({key:'stopping_protection', value:v, pct:true, origin:'derived', positive:v > 0});
    }

    // 6) Penalizaciones por hemorragia y quemaduras.
    const bl = Math.max(0, Math.min(4, build.bleeding|0));
    const regPen = (BLEEDING_PENALTIES[bl][0]||0) + (build.burning ? BURNING_PENALTIES.regeneration : 0);
    const effPen = (BLEEDING_PENALTIES[bl][1]||0) + (build.burning ? BURNING_PENALTIES.efficiency : 0);
    if (regPen > 0 || effPen > 0){
      for (const [k,pen] of [['regeneration_bonus',regPen],['heal_efficiency',effPen]]){
        if (pen <= 0) continue;
        let st = get(k);
        if (!st){ st = {key:k, value:0, pct:true, origin:'debuff'}; out.push(st); }
        st.value -= pen; st.positive = st.value > 0;
      }
    }

    out = out.filter(s => s.value !== 0);
    out.sort((a,b) => SORTED.indexOf(a.key) - SORTED.indexOf(b.key));

    const hb = get('health_bonus'), br = get('bullet_dmg_factor');
    const effectiveHealth = ((hb ? hb.value : 0) + 100)/100 * (100 + (br ? br.value : 0));
    const reg = get('regeneration_bonus'), ah = get('artefakt_heal'), he = get('heal_efficiency');
    const healingPerSecond = ((reg ? reg.value : 0) + 2.5)/5 + (ah ? ah.value : 0) * (1 + (he ? he.value : 0)/100);

    const alerts = out.filter(s => LIMITS[s.key] !== undefined && s.value > LIMITS[s.key]).map(s => s.key);

    return {stats: out, poly: polyStats, effectiveHealth, healingPerSecond, alerts,
            availableReactions: out.filter(s => REACTIONS.includes(s.key)).map(s => s.key)};
  }

  return {compute, artefactStats, statValue, rarityOf, addSlots, merge, armorValue,
          ACC, CONT_PROTECT, CAN_BOTH, POLY, REACTIONS, LIMITS, CATEGORY, CATEGORY_ORDER, CATEGORY_LABEL, SORTED, RIDX,
          BLEEDING_PENALTIES, BURNING_PENALTIES};
})();

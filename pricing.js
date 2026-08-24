/* =========================================================================
   PRECIOS DE MERCADO
   Instantánea del historial de subasta generada con tools/gen_prices.py.
   Es opcional: si data/prices.js no está, toda la interfaz de coste desaparece.
   ========================================================================= */
const PRICES = (() => {
  const P = window.SZ_PRICES || null;
  const QIDX = {'rarity.ordinary':0, 'rarity.unordinary':1, 'rarity.special':2, 'rarity.rare':3,
                'rarity.exclusive':4, 'rarity.legendary':5, 'rarity.unique':6};
  const has = () => !!(P && P.items && Object.keys(P.items).length);
  const qclass = q => QIDX[ENGINE.rarityOf(q)] || 0;

  /**
   * Precio estimado de un objeto en una combinación concreta de calidad y nivel.
   *
   * Se parte de las ventas realmente observadas y se corrigen al punto pedido con las
   * pendientes del ajuste (encarecimiento por nivel y por escalón de rareza), pesando
   * cada observación por su número de ventas y por lo cerca que está del punto. Así el
   * dato manda donde lo hay y el modelo sólo rellena los huecos.
   *
   * @returns {{value:number, exact:boolean, n:number}|null}
   */
  function estimate(id, level, quality){
    if (!P || !P.items[id]) return null;
    const m = P.items[id], qc = qclass(quality);
    let num = 0, den = 0, exact = null;
    for (const k in m.o){
      const c = k.indexOf(',');
      const q = +k.slice(0, c), lv = +k.slice(c + 1);
      const p = m.o[k][0], n = m.o[k][1];
      if (q === qc && lv === level) exact = {value: p, n};
      const w = n / ((1 + Math.abs(level - lv)) * (1 + 3 * Math.abs(qc - q)));
      num += w * (Math.log(p) + m.b * (level - lv) + m.c * (qc - q));
      den += w;
    }
    if (exact && exact.n >= 3) return {value: exact.value, exact: true, n: exact.n};
    if (!den) return null;
    return {value: Math.exp(num / den), exact: false, n: m.n};
  }

  /** Coste de una build completa. `missing` = objetos equipados sin datos de precio. */
  function ofBuild(b){
    let total = 0, missing = 0, estimated = 0;
    const add = (id, level, quality) => {
      const e = estimate(id, level, quality);
      if (!e){ missing++; return; }
      total += e.value;
      if (!e.exact) estimated++;
    };
    if (b.container) add(b.container.i, 0, 0);
    if (b.armor && b.armor.item) add(b.armor.item.i, b.armor.level, 0);
    for (const a of b.artefacts) if (a && a.item) add(a.item.i, a.level, a.quality);
    return {total, missing, estimated};
  }

  /** 1 850 000 → «1,85 M ₽» — los precios de subasta son demasiado largos en crudo. */
  function fmt(v){
    if (v === null || v === undefined) return '—';
    if (v >= 1e6) return (v / 1e6).toLocaleString('es', {maximumFractionDigits: 2}) + ' M ₽';
    if (v >= 1e3) return Math.round(v / 1e3).toLocaleString('es') + ' k ₽';
    return Math.round(v).toLocaleString('es') + ' ₽';
  }
  const fmtFull = v => Math.round(v).toLocaleString('es') + ' ₽';

  return {has, estimate, ofBuild, fmt, fmtFull, qclass,
          region: P ? P.region : null, generated: P ? P.generated : null, demo: P ? P.demo : false};
})();

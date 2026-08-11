const fs=require('fs'),vm=require('vm');
const ctx={window:{},console,performance};vm.createContext(ctx);
vm.runInContext(fs.readFileSync('data/gamedata.js','utf8'),ctx);
const html=fs.readFileSync('index.html','utf8');
const m=html.match(/const ENGINE = \(\(\) => \{[\s\S]*?\n\}\)\(\);/);
vm.runInContext(m[0]+';globalThis.ENGINE=ENGINE;',ctx);
const D=ctx.window.SZ_DATA,E=ctx.ENGINE;
const f=(L,n)=>L.find(x=>x.n.en===n);
const cont=f(D.containers,'Secret Valley 35 Backpack');
const armor=f(D.armors,'Albatross Interceptor Armored Exoskeleton');
const mk=(n,lvl,q)=>{const it=f(D.artefacts,n);return{item:it,level:lvl,quality:q,addSel:it.a.map((_,k)=>k).slice(0,E.addSlots(it.i,lvl))};};
const r=E.compute({container:cont,armor:{item:armor,level:15},
  artefacts:[mk('Wicked Hedgehog',15,175),mk('Transformer',15,175),mk('Spiral',0,100)],
  bleeding:0,burning:false,reactions:[]});
const exp={effectiveHealth:383.38,healingPerSecond:0.50,bleeding_accumulation:-0.50,bullet_dmg_factor:284.98,
 health_bonus:-0.42,speed_modifier:8.40,sprint_speed_modifier:2.72,stamina_bonus:78.28,max_weight_bonus:127.36,
 tear_dmg_factor:135.00,stopping_protection:57.45,explosion_dmg_factor:132.00,burn_dmg_factor:150.00,
 electra_dmg_factor:150.00,chemical_burn_dmg_factor:150.00,radiation_protection:300.00,thermal_protection:200.00,
 biological_protection:300.00,psycho_protection:300.00,bleeding_protection:40.00,reaction_to_electroshock:2.31,
 reaction_to_tear:1.89,biological_accumulation:-5.82,psycho_accumulation:-9.83,thermal_accumulation:-2.91,
 radiation_accumulation:-1.79};
const got={effectiveHealth:r.effectiveHealth,healingPerSecond:r.healingPerSecond};
r.stats.forEach(s=>got[s.key]=s.value);
let bad=0;
for(const k in exp){const g=got[k];const ok=g!==undefined&&Math.abs(g-exp[k])<0.011;if(!ok)bad++;
 console.log(`${ok?'OK  ':'FAIL'} ${k.padEnd(28)} esperado=${exp[k].toFixed(2).padStart(8)}  obtenido=${g===undefined?'AUSENTE':g.toFixed(2).padStart(8)}`);}
const extra=Object.keys(got).filter(k=>!(k in exp));
if(extra.length){bad++;console.log('EXTRA:',extra.map(k=>k+'='+got[k].toFixed(2)).join(', '));}
console.log(bad?`\n>>> ${bad} DIFERENCIAS`:'\n>>> MOTOR JS: 26/26 EXACTO');

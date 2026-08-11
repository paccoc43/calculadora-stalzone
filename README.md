# Calculadora de builds de artefactos — STALZONE

Calculadora de builds para STALZONE: combina mochila, armadura y artefactos, y muestra las
estadísticas finales del personaje. Incluye un **optimizador** que busca la mejor combinación de
artefactos para un objetivo concreto, un **comparador** de builds y **guardado/compartido**.

No necesita instalación: abre `index.html` en el navegador.

```
index.html          Interfaz, motor de cálculo y optimizador (todo en uno)
data/gamedata.js    Catálogo: 106 artefactos, 56 contenedores, 137 armaduras
tools/gen_data.py   Regenera el catálogo desde la API de stalzone.wiki
tools/test_*.js     Pruebas del motor y del optimizador (Node)
```

## Mecánicas implementadas

### Contenedores (mochilas)

| Propiedad | Efecto |
|---|---|
| **Capacidad** | Número de artefactos que puedes equipar (1 a 7). |
| **Eficiencia** | Multiplica los bonus de los artefactos. Las *acumulaciones* (radiación, bio, psi, temperatura, congelación) la ignoran. |
| **Protección** | Reduce las acumulaciones **dañinas** del conjunto de artefactos: `valor × (1 − protección/100)`. No se aplica a la congelación ni a los valores que ya son beneficiosos. |

### Artefactos

Cada estadística viene definida por un rango `[mín; máx]`. El resultado depende del **nivel** (0 a +15)
y de la **calidad / rareza** (0 a 175 %, hasta 190 en el caso único).

**Estadísticas positivas** — se parte siempre del extremo alto del rango:

```
valor = máx × (eficiencia/100) × (calidad/100) × (1 + 2 × nivel/100)
```

Es decir: el nivel aporta un **+2 % por punto** (+30 % a +15) y la calidad escala linealmente
(175 % ⇒ ×1,75). Las acumulaciones beneficiosas omiten el factor de eficiencia.

**Estadísticas negativas** — el nivel **no** las empeora ni las mejora, y saturan dentro de su franja
de rareza. Por debajo del 100 % interpolan entre mín y máx; por encima del 100 % se mueven sólo entre
el 85 % y el 100 % del extremo alto, según la posición dentro de la franja de 15 puntos.

**Franjas de rareza** (color y comportamiento de las stats negativas):

| Rango | Rareza | Color |
|---|---|---|
| 0 – 100 | Común | Blanco |
| 100 – 115 | Poco común | Verde |
| 115 – 130 | Especial | Azul |
| 130 – 145 | Raro | Morado |
| 145 – 160 | Exclusivo | Rojo |
| 160 – 175 | Legendario | Amarillo |
| 175 – 190 | Único | Naranja |

**Estadísticas adicionales.** Cada artefacto tiene un repertorio extra que se desbloquea con el nivel:
un hueco a **+5**, otro a **+10** y otro a **+15** (el artefacto *Rubik* desbloquea uno más ya a +1).
Se eligen con los botones bajo cada artefacto y se calculan con la misma fórmula.

### Cálculos derivados

```
Salud efectiva      = (100 + vitalidad)/100 × (100 + resistencia a balas)
Curación por segundo = (regeneración + 2,5)/5 + curación periódica × (1 + eficacia de curación/100)
Estabilidad         = (1 − 100/(100 + prot. laceración) × (1 − estabilidad/100)) × 100
```

### Estado del personaje

La hemorragia (niveles 0–4) y las quemaduras restan a la regeneración y a la eficacia de curación.
Las **reacciones a anomalías** activas suman su valor a la vitalidad y a la regeneración de aguante.

### Umbrales de daño

La calculadora avisa cuando una acumulación supera su límite: **0,5** para radiación, infección
biológica, emisiones psy y temperatura, y **1,0** para la congelación.

## Optimizador

Elige una estadística a maximizar y busca la combinación de artefactos que la consigue sin superar
los límites de acumulación. Usa la mochila y la armadura seleccionadas en la pestaña *Calculadora*.

Es un **branch & bound** exacto: representa la build como un vector de contribuciones y acota cada
rama sustituyendo los componentes del objetivo por el mejor aporte que queda disponible. Como todas
las transformaciones posteriores (protección, salud efectiva, estabilidad…) son monótonas crecientes
en esos componentes, la poda nunca puede descartar el óptimo. Cuando la búsqueda termina sin agotar
el tiempo, el resultado se marca como **óptimo garantizado**.

Opciones: nivel y calidad de los artefactos, permitir o no repetidos, límites de acumulación
editables, número de candidatos y tiempo máximo.

## Verificación

El motor replica la calculadora oficial de [stalzone.wiki](https://stalzone.wiki/en/builds-calculator).
Desde la raíz del repositorio:

```bash
node tools/test_reference.js   # build de referencia: 26/26 estadísticas exactas
node tools/test_engine.js      # 4000 builds aleatorias + branch & bound vs fuerza bruta
```

- `test_reference.js` reproduce una build conocida (Wicked Hedgehog +15 175 %, Transformer +15 175 %,
  Spiral 100 %, mochila Secret Valley 35, exoesqueleto Albatross Interceptor +15) y compara las 26
  estadísticas finales con las de la wiki.
- `test_engine.js` comprueba que la evaluación vectorizada del optimizador coincide con el motor en
  4000 builds aleatorias, y que el branch & bound encuentra el mismo óptimo que una fuerza bruta
  exhaustiva en 24 configuraciones distintas.

## Actualizar el catálogo

```bash
python tools/gen_data.py
```

Descarga el catálogo desde la API pública de la wiki y reescribe `data/gamedata.js`.

## Notas

- Los iconos se cargan desde el CDN de la wiki; sin conexión la app funciona igual, sólo sin imágenes.
- Las builds guardadas viven en el `localStorage` del navegador. El botón *Copiar enlace* genera una
  URL con la build codificada en el fragmento (`#b=…`), que sólo funciona si sirves la página por HTTP.
- Consumibles, granadas y el modo *Poliedro* del juego no están incluidos en la selección; las
  estadísticas de poliedro sí se calculan si un artefacto las tiene.

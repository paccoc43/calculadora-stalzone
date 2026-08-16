# Calculadora de builds de artefactos — STALZONE

Calculadora de builds para STALZONE: combina mochila, armadura y artefactos, y muestra las
estadísticas finales del personaje. Incluye un **optimizador** que busca la mejor combinación de
artefactos para un objetivo concreto, un **comparador** de builds y **guardado/compartido**.
Si se generan los precios de subasta, muestra además **cuánto cuesta la build** y permite
optimizar con presupuesto.

No necesita instalación: abre `index.html` en el navegador.

```
index.html          Interfaz, motor de cálculo y optimizador (todo en uno)
data/gamedata.js    Catálogo: 106 artefactos, 56 contenedores, 137 armaduras
data/prices.js      Precios de subasta (opcional, se genera aparte)
tools/gen_data.py   Regenera el catálogo desde la API de stalzone.wiki
tools/gen_prices.py Regenera los precios desde la API oficial de STALZONE
tools/test_*.js     Pruebas del motor, del optimizador y de los precios (Node)
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

Elige una o varias estadísticas a maximizar y busca la combinación de artefactos que las consigue
sin superar los límites de acumulación. La **mochila se elige en el propio optimizador** (arranca
con la de la pestaña *Calculadora* y a partir de ahí va por libre; al aplicar la build se lleva
también a la Calculadora). La armadura y el estado del personaje sí son los de la *Calculadora*.

Es un **branch & bound** exacto: representa la build como un vector de contribuciones y acota cada
rama sustituyendo los componentes del objetivo por el mejor aporte que queda disponible. Como todas
las transformaciones posteriores (protección, salud efectiva, estabilidad…) son monótonas crecientes
en esos componentes, la poda nunca puede descartar el óptimo. Cuando la búsqueda termina sin agotar
el tiempo, el resultado se marca como **óptimo garantizado**.

Opciones: nivel y calidad de los artefactos, permitir o no repetidos, límites de acumulación
editables, número de candidatos y tiempo máximo.

### Varias estadísticas a la vez

Se pueden añadir varios objetivos con un reparto en porcentaje (dos objetivos entran a 50/50).
Sumar sin más las estadísticas no serviría: la regeneración de aguante llega a 46 y la velocidad
a 13, así que la de números más grandes se llevaría toda la búsqueda. Por eso cada objetivo se
**normaliza** antes de mezclarlo:

1. Se busca cada estadística por separado, con las mismas restricciones (mochila, límites,
   presupuesto, nivel y calidad). Ese máximo es su escala.
2. Cada una se mide como `(valor − build vacía) / (máximo − build vacía)`: 0 = no aporta nada,
   1 = tan buena como si sólo se hubiera buscado ella.
3. El objetivo real es la media ponderada de esas fracciones, y el resultado se presenta como
   **objetivo combinado** en porcentaje, con el detalle de cuánto alcanza cada estadística.

Un 50/50 de velocidad de movimiento y regeneración de aguante en la Secret Valley 35 (nivel 15,
calidad 130 %, tope de 10 M ₽) llega al 80 % de cada una a la vez: 10,55 de velocidad de un máximo
de 13,13 y 37,05 de regeneración de un máximo de 46,12.

La media ponderada de funciones monótonas sigue siendo monótona, así que la cota del branch &
bound sigue siendo válida y el óptimo sigue estando garantizado. Un reparto 100/0 da exactamente
el mismo resultado que perseguir esa estadística sola.

Con precios cargados aparecen dos opciones más:

- **Presupuesto**: descarta cualquier conjunto que se pase del tope. El coste es aditivo y añadir
  artefactos sólo encarece, así que la rama entera se poda en cuanto se excede: sigue siendo un
  óptimo garantizado.
- **Por rublo**: maximiza la ganancia sobre la build vacía dividida por lo que cuesta. La cota se
  divide por el gasto ya comprometido —cualquier extensión de esa rama cuesta al menos eso— así que
  la poda tampoco puede descartar el óptimo. Explora más nodos que el modo normal porque la cota es
  más floja.

Los artefactos sin ventas registradas quedan fuera de la búsqueda cuando se usa cualquiera de las
dos: sin precio no se puede ni respetar un presupuesto ni medir el rendimiento por rublo.

## Precios de mercado

`data/prices.js` es **opcional**. Sin él la calculadora funciona igual, sólo que sin ninguna
referencia a costes. Con él aparecen el precio de cada artefacto, el coste total de la build, una
fila de coste en el comparador y las dos opciones del optimizador.

```bash
cp .env.example .env      # y rellena tus credenciales dentro
python tools/gen_prices.py                    # usa la región de .env
python tools/gen_prices.py --region eu        # ru | eu | na | sea
```

Las credenciales viven en `.env`, que está en `.gitignore` y **no debe subirse al repositorio**;
`.env.example` documenta el formato. También valen las variables de entorno del mismo nombre.
Se consiguen registrando una aplicación en el Discord de EXBO con el comando `/newapp`, y requieren
aprobación manual: <https://eapi.stalzone.net/registration.html>. Con `--demo` el script usa la API
de demostración, que no pide registro pero devuelve precios ficticios.

**Cómo se estima un precio.** La subasta registra cada venta con la calidad y el nivel de mejora del
lote, así que el generador agrupa el historial por esas dos variables y guarda la **mediana** de
cada grupo (no la media: hay traspasos a precio simbólico y reventas infladas). Sobre esos grupos
ajusta `log(precio) = a + b·nivel + c·rareza`, donde `b` y `c` salen de un modelo de efectos fijos
sobre todo el catálogo y se mezclan con los del propio objeto según cuántas ventas tenga.

Al consultar un precio manda siempre el dato observado: si hay ventas de esa calidad y ese nivel se
devuelve su mediana tal cual (se marca como exacta). Si no, se combinan las observaciones vecinas
corrigiéndolas con `b` y `c`, pesadas por número de ventas y cercanía. Los precios estimados se
marcan con `~` en la interfaz. En validación cruzada sobre el historial real el error típico de los
huecos ronda el 20 %, en un mercado donde el mismo artefacto se vende entre 1,3 y 2,5 millones.

**Qué cubren los datos.** Sólo los artefactos se subastan con nivel y calidad detallados: los de EU
dan más de 1400 combinaciones distintas. Las **armaduras y las mochilas se venden sin nivel de
mejora**, así que su precio es único y no cambia al mover el deslizador de nivel. Además muchas no
llegan a subastarse nunca (en EU cotizan 102 de 106 artefactos, pero sólo 27 de 137 armaduras y 20
de 56 mochilas): las que no tienen ventas se muestran sin precio y no suman al total de la build.

## Verificación

El motor replica la calculadora oficial de [stalzone.wiki](https://stalzone.wiki/en/builds-calculator).
Desde la raíz del repositorio:

```bash
node tools/test_reference.js   # build de referencia: 26/26 estadísticas exactas
node tools/test_engine.js      # 4000 builds aleatorias + branch & bound vs fuerza bruta
node tools/test_prices.js      # estimador de precios + presupuesto y «por rublo» vs fuerza bruta
node tools/test_multigoal.js   # objetivo múltiple: normalización y reparto de pesos vs fuerza bruta
```

- `test_reference.js` reproduce una build conocida (Wicked Hedgehog +15 175 %, Transformer +15 175 %,
  Spiral 100 %, mochila Secret Valley 35, exoesqueleto Albatross Interceptor +15) y compara las 26
  estadísticas finales con las de la wiki.
- `test_engine.js` comprueba que la evaluación vectorizada del optimizador coincide con el motor en
  4000 builds aleatorias, y que el branch & bound encuentra el mismo óptimo que una fuerza bruta
  exhaustiva en 24 configuraciones distintas.
- `test_prices.js` usa una instantánea de precios sintética (no necesita `data/prices.js`) para
  comprobar el estimador —dato exacto, interpolación, extrapolación, monotonía, ausencia de datos—
  y que el branch & bound con presupuesto y con objetivo por rublo sigue coincidiendo con la fuerza
  bruta en 30 configuraciones, sin pasarse nunca del presupuesto.
- `test_multigoal.js` comprueba el objetivo múltiple: que la media ponderada normalizada es la que
  dice ser, que el branch & bound sigue dando el óptimo exacto en 8 objetivos compuestos, que un
  reparto 100/0 equivale al objetivo suelto y que un 50/50 llega a un compromiso real entre dos
  estadísticas que compiten.

## Actualizar el catálogo

```bash
python tools/gen_data.py
```

Descarga el catálogo desde la API pública de la wiki y reescribe `data/gamedata.js`. Los precios van
por su cuenta: `python tools/gen_prices.py` (ver arriba).

## Notas

- Los iconos se cargan desde el CDN de la wiki; sin conexión la app funciona igual, sólo sin imágenes.
- Las builds guardadas viven en el `localStorage` del navegador. El botón *Copiar enlace* genera una
  URL con la build codificada en el fragmento (`#b=…`), que sólo funciona si sirves la página por HTTP.
- Consumibles, granadas y el modo *Poliedro* del juego no están incluidos en la selección; las
  estadísticas de poliedro sí se calculan si un artefacto las tiene.

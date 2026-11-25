# Calce + Matices

Aplicación web local que integra el análisis de color de Matices con las
recomendaciones de calce y el catálogo de Calce.

## Navegación

La app abre en **Home**, que presenta el escaparate con un banner, categorías,
productos destacados y una breve descripción de la experiencia. **Tu Calce**
conserva la guía para foto, medidas y recomendaciones de calce.

## Flujo integrado

1. Toma una foto con la cámara del dispositivo o selecciona una imagen. Al
   avanzar, la aplicación analiza sus tonos en el navegador y muestra una paleta
   recomendada con una explicación orientativa. Si activas **Recuérdame**, la
   foto se conserva en este navegador; con una sesión iniciada también se guarda
   en el almacenamiento privado de tu cuenta. Para usar el **Probador** tras ir
   al catálogo, la foto se restaura desde el almacenamiento temporal de este
   navegador, donde se conserva por hasta una hora y se elimina al quitarla.
2. Ingresa busto, cintura y cadera, y elige tu preferencia de calce y las
   prendas que quieres explorar. Las recomendaciones se calculan con tus
   medidas y el calce elegido.
3. Continúa al catálogo para buscar, filtrar por tipo, ordenar y comparar
   prendas. Las tarjetas y la comparación muestran el calce estimado y las
   medidas referenciales disponibles. Usa el botón **Añadir al carrito** con el
   símbolo de carrito en cada prenda para agregarla sin salir del catálogo.
   También puedes indicar la cantidad y talla que llevarás; estos campos no
   aparecen para Vestua, donde se conserva la talla publicada y se agrega una
   sola unidad. **Confirmar Pago** abre un checkout de demostración para ingresar
   una dirección y seleccionar una tarjeta guardada. En **Mi Perfil → Dirección**
   puedes guardar, editar y eliminar varias direcciones privadas de tu cuenta y
   reutilizarlas en el checkout. Las direcciones escritas solo durante el checkout
   no se guardan automáticamente. No se generan órdenes ni se procesan pagos;
   cada compra debe completarse directamente en la tienda de origen.
   Usa el corazón en la esquina inferior izquierda de una prenda para guardarla
   en **Favoritos**; encontrarás esa lista en el menú de usuario. Los favoritos
   se conservan en el almacenamiento local de este navegador.
   Sus tarjetas usan el mismo formato del Catálogo, con opciones de talla y
   acceso directo al carrito.

   El filtro **Tipo de prenda** agrupa las prendas superiores e inferiores y los
   vestidos. Omite las opciones **Ropa interior**, **Ropa de playa** y **Ropa**;
   esas prendas siguen apareciendo al elegir **Todos los tipos**.

La paleta es una orientación visual; no filtra prendas por color, porque el
catálogo no contiene datos de color verificados por producto. Las estimaciones
de calce son orientativas y usan las referencias disponibles, no medidas físicas
verificadas de cada publicación.

## Preparación y ejecución

Se requiere Python 3.9 o posterior. Instala las dependencias y ejecuta la app:

```bash
python3 -m pip install -r requirements.txt
python3 app.py
```

Abre <http://127.0.0.1:4173/>. También puedes iniciar con `npm start` después
de instalar las dependencias de Python. Para detener el servidor, presiona
`Ctrl+C` en la terminal.

La interfaz aplica una escala visual global de 150%. Esta escala se combina con
el zoom del navegador; por ejemplo, al 75% el tamaño efectivo equivale al 112,5%.
El fondo claro cubre también el lienzo HTML para evitar franjas negras fuera del
contenido al ampliar o reducir la ventana.

El acceso a la cámara requiere permiso del navegador y un contexto seguro:
usa `localhost` en este equipo o sirve la aplicación mediante HTTPS.

## API de probador virtual con RapidAPI

El botón **Probador** usa la foto seleccionada en **Inicio** y una prenda del
catálogo. Solo las cuentas con sesión iniciada pueden generar una prueba. La
El selector permite elegir **Automático**, **Try on Clothes Pro**, **DataToBiz**,
**Try-On Diffusion** o **Try on Clothes Refiner**. Automático intenta primero
Try on Clothes Pro y usa DataToBiz como respaldo. Try-On Diffusion funciona
independientemente con una sola prenda y envía los archivos al endpoint
`/try-on-file`. DataToBiz también funciona de forma independiente, pero admite
solo una prenda superior individual. Al elegir cualquiera de esos proveedores
directos, no se llama a los demás.

En **Probador**, las prendas seleccionadas en **Catálogo** aparecen en el listado
sin casillas ni botón de confirmación. Al pasar el puntero o el foco por una
prenda, se muestra su imagen de referencia. El total del listado aparece abajo
a la derecha. **Ir a Carrito** se habilita cuando hay prendas en el Probador y
abre la ventana **¿Qué desea llevar?** con las prendas seleccionadas inicialmente,
junto con la talla y cantidad indicadas en **Catálogo**. Cada prenda muestra
su cantidad en el cuadro **Cantidad a llevar**; puedes ajustar allí la cantidad
de París y desmarcar las prendas que quieras dejar fuera. Al seleccionar
una prenda de París para el Probador desde **Catálogo**, aparece una ventana
para elegir la talla que se usará en la prueba.
Al pulsar **Confirmar**, las prendas marcadas se agregan al carrito y se pregunta
si deseas ir a pagar: **Sí** abre el carrito y **No** vuelve al catálogo.
Después de confirmar, las casillas de selección del **Catálogo** para el
Probador se desmarcan; las prendas agregadas permanecen en el carrito.
Las categorías que los proveedores no admiten se muestran por separado y no
pueden seleccionarse para generar una prueba virtual.

Clothes Refiner es una etapa de mejora, no un generador independiente: primero
solicita una imagen preliminar a Try on Clothes Pro y después la envía junto con
la foto, el género elegido y las prendas a
`/portrait/enhance/try-on-clothes-refiner`. Por eso consume solicitudes de ambas
APIs y no funcionará si Try on Clothes Pro no tiene cuota o suscripción activa.

Configura `RAPIDAPI_KEY` y `DATATOBIZ_RAPIDAPI_KEY` en el `.env` local o como
variables de entorno. Try-On Diffusion y Clothes Refiner usan
`RAPIDAPI_DIFFUSION_KEY` y `RAPIDAPI_REFINER_KEY` respectivamente; si no se
definen, usan `RAPIDAPI_KEY`. Cada API requiere una suscripción activa en
RapidAPI. Copia `.env.example` como punto de partida y agrega las claves
necesarias como secretos en Render. La clave que usa el servidor web se
configura por separado de la conexión MCP de VS Code.

En modo **Automático**, si Try on Clothes Pro falla, la app intenta DataToBiz
una vez para una prenda superior individual e informa el error de cada API si
ambas fallan. No se hacen reintentos automáticos adicionales. Try-On Diffusion
admite una sola prenda por solicitud y no combina prendas.

La API requiere imágenes y procesa la solicitud de forma asíncrona. Las prendas
se separan en superiores, inferiores y vestidos. Una prenda superior se envía
como `top_garment`; una inferior se envía como `bottom_garment`. Puedes elegir
una de cada tipo para generar ambas en una sola imagen. Si eliges solo una
prenda inferior, como el proveedor también exige `top_garment`, se usa un
recorte central de la parte superior de la foto como referencia. El proveedor
puede modificar esa zona, así que el resultado no garantiza que la parte
superior quede idéntica. Para vestidos no se envía una prenda inferior. Las
fotos y las imágenes de las prendas se normalizan a JPEG (máximo 2048 píxeles y
5 MB) y se comparten directamente con RapidAPI; no se guardan en Supabase
Storage para esta operación. No uses el Probador si no aceptas ese envío. La
foto original se optimiza también en el navegador a un máximo de 1024 píxeles
para reducir la transferencia y el tiempo de procesamiento.

El archivo [`vton_api.py`](./vton_api.py) pertenece a la implementación anterior
con Modal y ya no es utilizado por la aplicación web.

## Publicar gratis en Render

El archivo [`../render.yaml`](../render.yaml) configura un servicio web
gratuito con un subdominio HTTPS de `onrender.com`. Sube este repositorio a
GitHub y, en Render, selecciona **New → Blueprint** y conecta el repositorio.
Render leerá la configuración y solicitará `SUPABASE_PUBLISHABLE_KEY`,
`RAPIDAPI_KEY` y las claves RapidAPI opcionales que quieras habilitar. No guardes
claves RapidAPI en el repositorio; para Supabase usa la clave publishable/anon,
nunca `service_role`.

La página será pública, pero las medidas, paletas y fotos de las cuentas siguen
protegidas por la autenticación y RLS de Supabase. Después del primer despliegue,
agrega `https://<subdominio>.onrender.com/**` a **Supabase → Authentication →
URL Configuration → Redirect URLs** para permitir confirmaciones e inicios de
sesión desde el dominio publicado.

El plan gratuito puede suspender el servicio tras un período sin actividad y
demorar su reactivación. Los datos persistentes de perfiles y fotos permanecen
en Supabase, no en el disco temporal de Render.

## Conexión con Supabase

La app permite crear cuentas con nombre y apellido, iniciar sesión y editar en
**Datos de Cuenta** el nombre, apellido, teléfono y medidas. En **Mi Perfil**,
Datos de Cuenta, Forma de Pago y Dirección aparecen en pestañas separadas; el menú
de usuario abre directamente cada sección. Las direcciones se guardan en la tabla
`user_addresses` de Supabase y RLS limita la lectura y modificación a su propietario.
Las medidas guardadas en el perfil
se sincronizan con Tu Calce. El teléfono se guarda como `+56 9 XXXX XXXX`.
**Forma de Pago** permite añadir y eliminar tarjetas de demostración, detectar su
marca y elegir una predeterminada. El formulario da formato al número de 16
dígitos y al vencimiento `MM/AA`; no ingreses datos reales. El número completo,
vencimiento y CVV no se envían ni se guardan y se descartan al cerrar el formulario.
El checkout muestra las tarjetas guardadas por marca, últimos cuatro dígitos y
nombre. En el almacenamiento local de este navegador, separado por cuenta, solo se
conservan esos datos y cuál tarjeta es la predeterminada; no se sincronizan con
Supabase ni procesan pagos. Las direcciones se guardan solo desde **Mi Perfil →
Dirección**; los datos introducidos únicamente en el checkout no se guardan.
La compra real se completa directamente en la tienda de cada prenda.
Al activar **Recuérdame** en el paso de la foto con una sesión iniciada, la foto
y la paleta se guardan en la cuenta. Las fotos de perfil y de Tu Calce se guardan
en un bucket privado de Supabase Storage, con acceso limitado a la persona
propietaria; se admiten fotos JPEG, PNG, WebP, GIF o AVIF de hasta 10 MB. Sin
sesión, Tu Calce y el Probador ocultan su contenido, solicitan iniciar sesión y
conservan el destino solicitado.

1. En el panel SQL de Supabase, ejecuta [`supabase/schema.sql`](./supabase/schema.sql).
   El esquema actualiza las tablas de perfiles y direcciones, sincroniza el correo
   desde Auth, crea el bucket privado y limita mediante RLS el acceso a cada perfil,
   dirección y foto. Si ya ejecutaste una versión anterior, vuelve a ejecutar el
   archivo completo.
2. En la configuración API del proyecto, copia la **publishable key** (o la
   antigua clave `anon`). No uses la clave `service_role`.
3. Copia `.env.example` como `.env` en la raíz del proyecto y pega allí la
   publishable key. `.env` se excluye de Git. También puedes
   definir `SUPABASE_PUBLISHABLE_KEY` en el entorno; las variables existentes
   del entorno tienen prioridad sobre `.env`.

   ```bash
   cp .env.example .env
   # Edita .env y agrega la publishable key del proyecto
   python3 app.py
   ```

   La URL del proyecto ya está configurada como
   `https://twhszjxhmimqlzthlbgy.supabase.co`; se puede cambiar mediante
   `SUPABASE_URL`.
4. En el paso **Medidas**, crea una cuenta o inicia sesión. Si Supabase requiere
   confirmar el correo, revisa el mensaje de confirmación antes de iniciar
   sesión. En el inicio de sesión, **Recuérdame** conserva la sesión entre
   visitas; si lo dejas desmarcado, la sesión termina al cerrar la pestaña.
   Activa **Recordar medidas en mi cuenta** para sincronizar medidas y paleta.
   **Recordar foto en mi cuenta** guarda una copia privada de la foto;
   desactivar la opción o eliminar la foto también la borra de Supabase. En
   **Mi Perfil**, usa las pestañas **Datos de Cuenta** y **Forma de Pago**. La
   primera guarda tus datos y medidas; la segunda administra métodos de
   demostración local en el navegador, disponibles en el checkout de prueba,
   que no procesa cargos.
5. Si la confirmación por correo está activada, agrega la URL local de la app
   (por ejemplo `http://127.0.0.1:4173/**`) a **Authentication → URL
   Configuration → Redirect URLs** en Supabase.

La publishable key se envía al navegador y no es una clave secreta; la seguridad
depende de RLS y de no exponer nunca una clave `service_role`. La autenticación
usa Supabase JS desde jsDelivr, por lo que requiere conexión a internet.

Al iniciar, la aplicación intenta abrir la URL en Google Chrome. En VS Code,
selecciona **Medidas: ejecutar en Chrome** en el panel **Ejecutar y depurar** y
presiona `F5`. En macOS también puedes abrir `Iniciar Medidas.command` para
abrir el proyecto en VS Code e iniciar la app; Chrome se abrirá al arrancar el
servidor.

## Estructura del proyecto

- `app.py`: punto de entrada; coordina el inicio del servidor local.
- `medidas/`: perfil corporal, lectura de medidas y recomendación según la tabla estándar.
- `prendas/`: modelo de prenda, catálogo y repositorio Excel.
- `metricas/`: cálculo de holguras, puntuación y diagnóstico.
- `web/`: servidor, plantilla HTML, estilos y recursos de interfaz.
- La interfaz usa el isotipo de Calce, una paleta azul/coral/magenta y la
  tipografía Montserrat.
- `data/Matriz_Medidas_Marcas_Vestua.xlsx`: fuente de productos y variables.
- `data/vestua_images.json`: imágenes de referencia y enlaces a Vestua por marca y categoría.
- `data/vestua_catalog.json`: instantánea de publicaciones únicas de Vestua con título, categoría, talla, precio y URL.
- `data/tiendas_mujer.json`: instantánea de prendas con imagen de Tricot y Paris.
- `scripts/importar_catalogo_mujer.py`: actualiza la instantánea pública de productos.
- `data/Tabla_estandar.xlsx`: rangos corporales de referencia usados para estimar tallas.

El catálogo y los factores de calce se cargan desde sus respectivas hojas del
Excel al iniciar la aplicación. Las filas que repiten la misma marca, categoría,
atributos y medidas se cuentan una sola vez, aunque tengan distinta línea o
submarca. La matriz aporta 42 referencias únicas, pero la app solo recomienda
las que tienen una publicación de Vestua enlazada e identificada; actualmente
son 38. El catálogo separado conserva 584 fichas únicas recopiladas el 29 de octubre
de 2026; es una instantánea y no se actualiza automáticamente. La app muestra
solo las publicaciones que tienen una referencia de imagen disponible; el resto
se omite. También se excluye cualquier publicación identificada como calzado.
Desde el catálogo también se puede abrir la colección de mujer de
[Paris](https://www.paris.cl/mujer/) y [Tricot](https://www.tricot.cl/mujer).
La instantánea actual contiene 2.176 fichas con imagen de Tricot (revisadas el
29 de octubre de 2026) y 9.855 de Paris (revisadas el 24 de noviembre de 2026),
recopiladas al recorrer las 331 páginas de la categoría de moda de Paris
(33.079 resultados informados). El importador consulta la API pública de Paris
en lotes de 100 productos y conserva solo fichas con imagen, excluyendo
calzado. Las tallas listadas por sus variantes se muestran en un selector con
una estimación de ajuste por talla basada en las medidas ingresadas y la tabla
estándar; es orientativa, y la disponibilidad de stock debe confirmarse en la
ficha de Paris. Para actualizar los datos públicos, ejecuta
`python3 scripts/importar_catalogo_mujer.py`; el proceso puede tardar varios
minutos debido al volumen de Paris. Al pulsar la imagen de cada tarjeta se abre
la ficha de producto en la tienda de origen.
El catálogo público de Paris no informa el stock por talla. Para marcar
manualmente una talla agotada, añade `out_of_stock_sizes` al producto
correspondiente en `data/tiendas_mujer.json`, por ejemplo `["M"]`; se mostrará
en gris y no se podrá elegir. El importador conserva estas marcas mientras la
talla siga apareciendo entre las variantes del producto.
Las combinaciones sin referencia de medidas no reciben una puntuación de calce.
Los valores de calce provienen de la matriz y son orientativos: no son medidas
verificadas de la publicación enlazada.
El selector de marca comienza en Zara. La marca y el tipo de prenda recomendados
corresponden a una misma referencia elegible: la que obtiene la menor puntuación
al comparar sus medidas con el perfil. Los resultados del carrusel respetan los
filtros seleccionados.
En Tu Calce, un carrusel adicional recomienda prendas con foto y enlace a su ficha
en Paris y Tricot según el calce estimado y el tipo de prenda seleccionado. Las
medidas se calculan con referencias de la matriz; no son medidas físicas
publicadas por las tiendas.
Las pestañas **Todas**, **Arriba** y **Abajo** filtran por todas las prendas,
prendas superiores (poleras, blusas, tops, blazers y vestidos) o inferiores
(pantalones y jeans), respectivamente. El selector de tipo de prenda muestra
solo las categorías disponibles en el catálogo. Las recomendaciones de
La aplicación pide busto/pecho, cintura y cadera. La estimación de talla usa las
tres medidas; la puntuación de calce de las prendas usa
cintura y cadera porque las referencias de Vestua no publican medidas físicas
individuales de busto.
Las medidas de la matriz se repiten entre marcas para cada categoría; por eso,
cuando hay empate, la app muestra todas las marcas con mejor puntuación y no
afirma que una marca ajuste mejor que otra. Estas referencias no sustituyen
medidas verificadas por producto.
En Tu Calce, después de las recomendaciones principales aparece otro carrusel
con las demás prendas cuyo diagnóstico indica calce compatible o cercano;
excluye las opciones ya mostradas en el carrusel principal y requiere medidas
para comparar. La sección **Info** reúne la metodología y los factores de la matriz de calce.
Las tallas se estiman con los rangos de referencia adjuntos, que no se muestran
como tabla en la interfaz; la matriz no contiene
tablas oficiales específicas por marca, por lo que se debe confirmar la guía
oficial antes de comprar. La conversión a tallas de EE. UU. es aproximada.
Las referencias son orientativas y no garantizan el
calce. Las imágenes enlazan a publicaciones de Vestua de la misma marca y
categoría; son referenciales, no necesariamente la misma prenda de la matriz y
pueden cambiar o dejar de estar disponibles. Si no hay una publicación enlazada
para una combinación, esa referencia no se recomienda.
Junto a cada imagen también se muestra la talla indicada en su publicación
en Vestua; puede ser distinta de la prenda del Excel y cambiar si la publicación
se actualiza.
La vista **Home** presenta categorías y productos destacados; **Tu Calce**,
**Catálogo**, **Probador** e **Info** abren secciones independientes. El catálogo
muestra productos con imagen de las instantáneas de Vestua, Tricot y Paris.
Muestra nueve prendas
por página (3 columnas × 3 filas en
pantallas amplias), con búsqueda, filtro por tipo, paginación y orden por precio
o puntuación. Los filtros y el orden consultan el catálogo completo en el
servidor y solo envían las nueve tarjetas de la página actual al navegador. Las
fichas publicadas no
incluyen medidas físicas cintura/cadera por producto: cuando es posible, la
puntuación usa una referencia del mismo tipo y marca, o una referencia promedio
del catálogo, y se identifica como estimación. No se asignan holguras a
publicaciones sin un tipo comparable. Los precios y tallas proceden de la
consulta del catálogo y pueden cambiar. Se pueden seleccionar varias prendas
para comparar diagnóstico, medidas referenciales y precio; cada enlace lleva a
Vestua para confirmar disponibilidad y completar la compra.
Cada tarjeta indica en la esquina superior derecha el diagnóstico estimado de
calce con las medidas de cintura y cadera ingresadas en Tu Calce. Si faltan medidas
o una referencia comparable, se informa en la tarjeta en vez de presentar un
resultado como seguro.

La casilla **Recordar** guarda las medidas en el almacenamiento local del
navegador actual. Al desmarcarla, elimina las medidas guardadas en ese navegador.

El filtro de marca y las recomendaciones identifican de forma orientativa el
origen de molde de las marcas incluidas (europeo/Inditex, europeo/británico o
americano). Esta clasificación es informativa: no cambia la comparación ni la
puntuación, que se calculan con las medidas de cada prenda del catálogo. El
catálogo actual no incluye marcas de molde asiático.

## Pruebas

```bash
python3 -m unittest discover -s tests -v
```

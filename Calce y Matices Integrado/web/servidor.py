import base64
import binascii
from concurrent.futures import ThreadPoolExecutor
from html import escape
from http.client import IncompleteRead
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from mimetypes import guess_type
from pathlib import Path
from dataclasses import replace
from functools import lru_cache
import gzip
import io
import json
from math import isfinite
import os
import re
from statistics import median
import subprocess
import sys
import time
import uuid
from typing import Dict, MutableMapping, Optional, Tuple
import unicodedata
from urllib.parse import parse_qs, quote, urlencode, urlparse
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
import webbrowser

from medidas.perfil_medidas import PerfilMedidas
from medidas.tallas import RepositorioTallasEstandar, recomendar_tallas
from metricas.calculadora_calce import CalculadoraCalce, PREFERENCIAS_CALCE
from metricas.resultado_calce import ResultadoCalce
from prendas import (
    CatalogoPrendas,
    Prenda,
    ProductoVestua,
    RepositorioExcelPrendas,
    RepositorioVestua,
)


ROOT = Path(__file__).resolve().parents[1]
WEB_DIRECTORY = Path(__file__).resolve().parent


def _load_environment_file(
    path: Path,
    environment: Optional[MutableMapping[str, str]] = None,
) -> None:
    try:
        contents = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return
    except OSError as error:
        raise RuntimeError(f"No se pudo leer la configuración local {path}.") from error

    target_environment = os.environ if environment is None else environment
    for line in contents.splitlines():
        entry = line.strip()
        if not entry or entry.startswith("#"):
            continue
        if entry.startswith("export "):
            entry = entry[len("export "):].lstrip()
        key, separator, value = entry.partition("=")
        key = key.strip()
        if not separator or not key:
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
            value = value[1:-1]
        target_environment.setdefault(key, value)


_load_environment_file(ROOT / ".env")
MATRIX_PATH = ROOT / "data" / "Matriz_Medidas_Marcas_Vestua.xlsx"
SIZE_CHART_PATH = ROOT / "data" / "Tabla_estandar.xlsx"
HOST = "127.0.0.1"
PORT = 4173
IS_RENDER = os.environ.get("RENDER", "").lower() == "true"
SUPABASE_URL = os.environ.get(
    "SUPABASE_URL", "https://twhszjxhmimqlzthlbgy.supabase.co"
).rstrip("/")
SUPABASE_PUBLISHABLE_KEY = os.environ.get("SUPABASE_PUBLISHABLE_KEY", "")
RAPIDAPI_KEY = os.environ.get("RAPIDAPI_KEY", "").strip()
RAPIDAPI_DIFFUSION_KEY = (
    os.environ.get("RAPIDAPI_DIFFUSION_KEY", "").strip() or RAPIDAPI_KEY
)
RAPIDAPI_REFINER_KEY = (
    os.environ.get("RAPIDAPI_REFINER_KEY", "").strip() or RAPIDAPI_KEY
)
RAPIDAPI_HOST = "try-on-clothes-pro.p.rapidapi.com"
RAPIDAPI_ENDPOINT = (
    f"https://{RAPIDAPI_HOST}/portrait/editing/try-on-clothes-pro"
)
RAPIDAPI_TASK_RESULT_ENDPOINT = (
    f"https://{RAPIDAPI_HOST}/api/rapidapi/query-async-task-result"
)
DATATOBIZ_RAPIDAPI_KEY = os.environ.get("DATATOBIZ_RAPIDAPI_KEY", "").strip()
DATATOBIZ_RAPIDAPI_HOST = "virtual-try-on2.p.rapidapi.com"
DATATOBIZ_RAPIDAPI_ENDPOINT = (
    f"https://{DATATOBIZ_RAPIDAPI_HOST}/clothes-virtual-tryon"
)
DIFFUSION_RAPIDAPI_HOST = "try-on-diffusion.p.rapidapi.com"
DIFFUSION_RAPIDAPI_ENDPOINT = (
    f"https://{DIFFUSION_RAPIDAPI_HOST}/try-on-file"
)
REFINER_RAPIDAPI_HOST = "try-on-clothes-refiner.p.rapidapi.com"
REFINER_RAPIDAPI_ENDPOINT = (
    f"https://{REFINER_RAPIDAPI_HOST}/portrait/enhance/try-on-clothes-refiner"
)
REFINER_RAPIDAPI_TASK_RESULT_ENDPOINT = (
    f"https://{REFINER_RAPIDAPI_HOST}/api/rapidapi/query-async-task-result"
)
MAX_VTON_IMAGE_BYTES = 5 * 1024 * 1024
MAX_VTON_REQUEST_BYTES = 8 * 1024 * 1024
MAX_CATALOG_IMAGE_BYTES = 20 * 1024 * 1024
MAX_RAPIDAPI_IMAGE_BYTES = 5 * 1024 * 1024
MAX_RAPIDAPI_RESPONSE_BYTES = 1024 * 1024
MAX_DATATOBIZ_RESPONSE_BYTES = 20 * 1024 * 1024
RAPIDAPI_EARLY_POLL_INTERVALS_SECONDS = (1, 2, 2)
RAPIDAPI_POLL_INTERVAL_SECONDS = 5
RAPIDAPI_TASK_TIMEOUT_SECONDS = 540


class TryOnProvidersError(Exception):
    def __init__(self, primary_error: Exception, fallback_error: Exception):
        self.primary_error = primary_error
        self.fallback_error = fallback_error
        super().__init__("Fallaron la API principal y la alternativa.")


REPOSITORY = RepositorioExcelPrendas(MATRIX_PATH)
VARIABLES = REPOSITORY.cargar_variables()
STANDARD_SIZES = RepositorioTallasEstandar(SIZE_CHART_PATH).cargar()
VESTUA_IMAGES_PATH = ROOT / "data" / "vestua_images.json"
with VESTUA_IMAGES_PATH.open(encoding="utf-8") as image_file:
    VESTUA_IMAGES = json.load(image_file)
VESTUA_CATALOG_PATH = ROOT / "data" / "vestua_catalog.json"
VESTUA_PRODUCTS = RepositorioVestua(VESTUA_CATALOG_PATH).cargar()
VESTUA_IMAGES_BY_URL = {
    reference["product_url"]: reference
    for brand_references in VESTUA_IMAGES.values()
    for reference in brand_references.values()
    if reference.get("product_url")
}
WOMENSWEAR_CATALOG_PATH = ROOT / "data" / "tiendas_mujer.json"
with WOMENSWEAR_CATALOG_PATH.open(encoding="utf-8") as catalog_file:
    WOMENSWEAR_DATA = json.load(catalog_file)
WOMENSWEAR_PRODUCTS = tuple(
    ProductoVestua(
        id=item["id"],
        titulo=item["title"],
        categorias_catalogo=item["catalog_categories"],
        tipo_prenda=item["type"],
        marca=item["brand"],
        categoria_referencia=item["reference_category"],
        talla=item["size"],
        precio_clp=item["price_clp"],
        url=item["url"],
        fecha_consulta=WOMENSWEAR_DATA["checked_at"],
    )
    for item in WOMENSWEAR_DATA["products"]
)
WOMENSWEAR_IMAGES_BY_URL = {
    item["url"]: item["image_url"] for item in WOMENSWEAR_DATA["products"]
}
WOMENSWEAR_STORES_BY_URL = {
    item["url"]: item["store"] for item in WOMENSWEAR_DATA["products"]
}
CATALOG_IMAGES_BY_URL = {
    **{
        url: reference["image_url"]
        for url, reference in VESTUA_IMAGES_BY_URL.items()
    },
    **WOMENSWEAR_IMAGES_BY_URL,
}
CATALOG_STORES_BY_URL = {
    **{url: "Vestua" for url in VESTUA_IMAGES_BY_URL},
    **WOMENSWEAR_STORES_BY_URL,
}


def _is_footwear(product: ProductoVestua) -> bool:
    product_details = " ".join(
        (product.titulo, product.tipo_prenda, product.categorias_catalogo)
    )
    normalized_details = _normalize_search_text(product_details)
    return bool(
        re.search(
            r"\b(?:calzad\w*|zapat\w*|sandali\w*|botin\w*|bota\w*|"
            r"mocasin\w*|alpargat\w*|pantufl\w*|tacon\w*|taco\w*|"
            r"stiletto\w*|oxford\w*|loafer\w*|sneaker\w*|shoe\w*|"
            r"boot\w*|heel\w*|sandal\w*|slipper\w*|chancl\w*|"
            r"chala\w*|ojota\w*)\b",
            normalized_details,
        )
    )


def _normalize_search_text(value: str) -> str:
    return "".join(
        character
        for character in unicodedata.normalize("NFD", value.casefold())
        if unicodedata.category(character) != "Mn"
    )


VTON_UPPER_BODY_TYPES = frozenset(
    _normalize_search_text(value)
    for value in (
        "Accesorio",
        "Bata",
        "Blazer",
        "Blusa",
        "Body",
        "Camisa",
        "Camisola",
        "Cardigan",
        "Chaleco",
        "Chaqueta",
        "Corset",
        "Enterito",
        "Kimono",
        "Parka",
        "Peto",
        "Pijama",
        "Polera",
        "Polerón",
        "Sweater",
        "Top",
    )
)
VTON_LOWER_BODY_TYPES = frozenset(
    _normalize_search_text(value)
    for value in (
        "Buzo",
        "Calza",
        "Falda",
        "Jeans",
        "Pantalón",
        "Shorts",
    )
)
EXCLUDED_CATALOG_FILTER_TYPES = frozenset(
    _normalize_search_text(value)
    for value in ("Ropa interior", "Ropa de playa", "Ropa")
)


CATALOG_PRODUCTS = tuple(
    product
    for product in (*VESTUA_PRODUCTS, *WOMENSWEAR_PRODUCTS)
    if not _is_footwear(product)
    and (
        (image_url := CATALOG_IMAGES_BY_URL.get(product.url))
        and urlparse(image_url).scheme == "https"
        and urlparse(image_url).netloc
    )
)
CATALOG_PRODUCTS_BY_URL = {product.url: product for product in CATALOG_PRODUCTS}
CATALOG_SEARCH_TEXT_BY_URL = {
    product.url: _normalize_search_text(
        " ".join(
            (
                CATALOG_STORES_BY_URL.get(product.url, "Vestua"),
                product.titulo,
                product.marca,
                product.categorias_catalogo,
            )
        )
    )
    for product in CATALOG_PRODUCTS
}
WOMENSWEAR_STORES = (
    ("Paris", "https://www.paris.cl/mujer/"),
    ("Tricot", "https://www.tricot.cl/mujer"),
)
CATALOG_PAGE_SIZE = 20
CATALOG_SORT_OPTIONS = (
    ("fit-asc", "Mejor calce"),
    ("fit-desc", "Peor calce"),
    ("price-asc", "Precio: menor a mayor"),
    ("price-desc", "Precio: mayor a menor"),
)


def _virtual_try_on_category_for_type(product_type: str) -> str:
    normalized_type = _normalize_search_text(product_type)
    if normalized_type in EXCLUDED_CATALOG_FILTER_TYPES:
        return "excluded"
    if normalized_type == "vestido":
        return "dresses"
    if normalized_type in VTON_UPPER_BODY_TYPES:
        return "upper_body"
    if normalized_type in VTON_LOWER_BODY_TYPES:
        return "lower_body"
    return "other"


def _virtual_try_on_category(product: ProductoVestua) -> str:
    return _virtual_try_on_category_for_type(product.tipo_prenda)


def _catalog_type_filter_groups(
    types: Tuple[str, ...],
) -> Tuple[Tuple[str, Tuple[str, ...]], ...]:
    categories = (
        ("Prendas superiores", "upper_body"),
        ("Prendas inferiores", "lower_body"),
        ("Vestidos", "dresses"),
        ("Otras prendas", "other"),
    )
    return tuple(
        (
            label,
            tuple(
                product_type
                for product_type in types
                if _virtual_try_on_category_for_type(product_type) == category
            ),
        )
        for label, category in categories
    )


def _has_vestua_listing(prenda) -> bool:
    reference = VESTUA_IMAGES.get(prenda.marca, {}).get(prenda.categoria, {})
    product_url = urlparse(reference.get("product_url", ""))
    image_url = urlparse(reference.get("image_url", ""))
    path_parts = product_url.path.strip("/").split("/")
    return bool(
        reference.get("product_title")
        and product_url.scheme == "https"
        and product_url.netloc == "www.vestua.cl"
        and len(path_parts) >= 3
        and path_parts[:2] == ["store", "product"]
        and path_parts[2].isdigit()
        and image_url.scheme == "https"
        and reference.get("image_url")
    )


CATALOG = CatalogoPrendas(
    prenda for prenda in REPOSITORY.cargar_prendas() if _has_vestua_listing(prenda)
)
CALCULATOR = CalculadoraCalce()
_CATEGORY_REFERENCES = {}
for _category in CATALOG.categorias():
    _category_references = CATALOG.filtrar(categoria=_category)
    if _category_references:
        _representative = _category_references[0]
        _CATEGORY_REFERENCES[_category] = replace(
            _representative,
            cintura=median(item.cintura for item in _category_references),
            cadera=median(item.cadera for item in _category_references),
        )
_BRAND_CATEGORY_REFERENCES = {
    (prenda.marca, prenda.categoria): prenda
    for prenda in CATALOG.prendas
}
MEASUREMENT_FIELDS = (
    ("bust", "Busto / pecho", "40", "200", "0.5", "p. ej. 90"),
    ("waist", "Cintura", "40", "180", "0.5", "p. ej. 74"),
    ("hip", "Cadera", "40", "200", "0.5", "p. ej. 100"),
)
BRAND_MOLD_ORIGINS = {
    "Zara": "europeo / Inditex",
    "H&M": "europeo",
    "Mango": "europeo / Inditex",
    "ASOS": "europeo / británico",
    "Levi's": "americano",
    "Nike": "americano",
}
CATEGORY_GROUPS = {
    "__all__": CATALOG.categorias(),
    "__top__": ("Blusa", "Polera", "Top Deportivo", "Blazer", "Vestido"),
    "__bottom__": ("Pantalon", "Pantalón", "Jeans"),
}
IMPACT_PRIORITY = {"Muy Alto": 0, "Alto": 1, "Medio": 2, "Bajo": 3}
MEASUREMENT_HELP = {
    "bust": (
        "Mide alrededor de la parte más amplia del pecho, manteniendo la cinta "
        "horizontal y sin apretar."
    ),
    "waist": (
        "Mide alrededor de la parte más estrecha de la cintura "
        "(usualmente justo por encima del ombligo)"
    ),
    "hip": (
        "Junta los pies y mide alrededor de la parte más ancha de las "
        "caderas y glúteos."
    ),
}


def _reference_for_listing(
    product: ProductoVestua,
) -> Tuple[Optional[Prenda], str]:
    category = product.categoria_referencia
    if category is None:
        return None, ""
    reference = _BRAND_CATEGORY_REFERENCES.get((product.marca, category))
    if reference is not None:
        return reference, f"{category} · referencia de matriz para {product.marca}"
    reference = _CATEGORY_REFERENCES.get(category)
    if reference is None:
        return None, ""
    return reference, f"{category} · referencia promedio del catálogo"


@lru_cache(maxsize=512)
def _calculate_fit(
    prenda: Prenda,
    perfil: PerfilMedidas,
    preferencia: str,
) -> ResultadoCalce:
    return CALCULATOR.calcular(prenda, perfil, preferencia)


def _option(value: str, label: str, selected: str) -> str:
    selected_attribute = " selected" if value == selected else ""
    return (
        f'<option value="{escape(value, quote=True)}"'
        f'{selected_attribute}>{escape(label)}</option>'
    )


def _measurement_fields(query: Dict[str, str]) -> str:
    fields = []
    for key, label, minimum, maximum, step, placeholder in MEASUREMENT_FIELDS:
        optional = " <small>cm</small>"
        value = escape(query.get(key, ""), quote=True)
        help_text = MEASUREMENT_HELP.get(key)
        help_button = (
            f'<button class="measurement-help-trigger" type="button" '
            f'aria-label="Ayuda para {escape(label, quote=True)}" '
            f'aria-describedby="measurement-help-{key}">?</button>'
            f'<span class="measurement-tooltip" id="measurement-help-{key}" role="tooltip">'
            f'{escape(help_text)}</span>'
            if help_text
            else ""
        )
        fields.append(
            f'<div class="measurement-field"><div class="field-label">'
            f'<label for="measurement-{key}">{escape(label)}{optional}</label>'
            f'{help_button}</div>'
            f'<input class="measurement-input" id="measurement-{key}" name="{key}" '
            f'type="number" min="{minimum}" max="{maximum}" '
            f'step="{step}" placeholder="{placeholder}" inputmode="decimal" value="{value}">'
            '</div>'
        )
    return "".join(fields)


def _personal_recommendations(
    perfil: PerfilMedidas,
    preferencia: str,
    catalog_url: str = "/?view=catalog",
) -> str:
    coincidencias = []
    for prenda in CATALOG.prendas:
        resultado = CALCULATOR.calcular(prenda, perfil, preferencia)
        if not isfinite(resultado.puntuacion) or resultado.diagnostico.etiqueta == "Revisión parcial":
            continue
        coincidencias.append((prenda, resultado))

    tallas, coincide_todo = recomendar_tallas(perfil, STANDARD_SIZES)
    if not coincidencias:
        summary = (
            '<p class="sub">Completa medidas corporales para comparar las marcas '
            "y tipos de prenda que cuentan con datos suficientes.</p>"
        )
        brand = "Aún sin datos suficientes"
        category = "Aún sin datos suficientes"
        brand_origin = None
        brand_label = "Marca más recomendada"
        category_label = "Tipo de ropa recomendado"
    else:
        puntuacion_minima = min(
            resultado.puntuacion for _, resultado in coincidencias
        )
        mejores = tuple(
            (prenda, resultado)
            for prenda, resultado in coincidencias
            if abs(resultado.puntuacion - puntuacion_minima) < 1e-9
        )
        marcas = tuple(dict.fromkeys(prenda.marca for prenda, _ in mejores))
        categorias = tuple(dict.fromkeys(prenda.categoria for prenda, _ in mejores))
        brand = ", ".join(escape(marca) for marca in marcas)
        category = ", ".join(escape(tipo) for tipo in categorias)
        brand_origin = BRAND_MOLD_ORIGINS.get(marcas[0]) if len(marcas) == 1 else None
        brand_label = (
            "Marcas con mejor coincidencia"
            if len(marcas) > 1
            else "Marca más recomendada"
        )
        category_label = (
            "Tipos de ropa con mejor coincidencia"
            if len(categorias) > 1
            else "Tipo de ropa recomendado"
        )
        summary = (
            '<p class="sub">Las referencias mostradas tienen la menor diferencia '
            "respecto a tus medidas.</p>"
            if len(marcas) == 1
            else '<p class="sub">Hay un empate entre marcas. La matriz repite las '
            "mismas medidas por categoría, así que estos datos no permiten "
            "distinguir el calce entre ellas.</p>"
        )

    if not tallas:
        sizes = "Ingresa busto, cintura o cadera"
        size_note = ""
    else:
        sizes = ", ".join(
            escape(talla.etiqueta)
            + (
                f" (EU {escape(talla.europea)})"
                if talla.europea
                else ""
            )
            + (
                f" (EE.UU. {escape(talla.estadounidense)})"
                if talla.estadounidense
                else ""
            )
            for talla in tallas
        )
        size_note = (
            "Todas las medidas ingresadas están dentro de estos rangos."
            if coincide_todo
            else "Son las tallas más cercanas."
        )
    brand_origin_markup = (
        f'<small class="brand-mold-origin">Molde {escape(brand_origin)}</small>'
        if coincidencias and brand_origin
        else ""
    )

    return (
        '<section class="personal-recommendations" aria-label="Resumen de recomendaciones">'
        '<div class="help-heading">'
        '<button class="measurement-help-trigger" type="button" '
        'aria-label="Ayuda sobre recomendaciones según tus medidas" '
        'aria-describedby="recommendations-help">?</button>'
        '<span class="measurement-tooltip" id="recommendations-help" role="tooltip">'
        "La talla se estima con busto/pecho, cintura y cadera. El cálculo de "
        "calce de las prendas considera cintura y cadera, ya que las fichas "
        "importadas de Vestua no publican medidas físicas exactas.</span></div>"
        f"{summary}"
        '<div class="recommendation-summary">'
        f'<div><span>{brand_label}</span><strong>{brand}</strong>'
        f'{brand_origin_markup}</div>'
        f'<div><span>{category_label}</span><strong>{category}</strong></div>'
        f'<div><span>Talla alfa</span><strong>{sizes}</strong>'
        f'<small>{escape(size_note)}</small></div>'
        "</div>"
        "</section>"
    )


def _format_price(price: Optional[int]) -> str:
    if price is None:
        return "Precio no disponible"
    return f"${price:,}".replace(",", ".")


def _catalog_product_card(
    product: ProductoVestua,
    reference: Optional[object],
    result: Optional[ResultadoCalce],
    reference_label: str,
    indice: int,
    preferencia: str,
    perfil: PerfilMedidas,
) -> str:
    store = CATALOG_STORES_BY_URL.get(product.url, "Vestua")
    image_url = CATALOG_IMAGES_BY_URL.get(product.url, "")
    price_value = "" if product.precio_clp is None else str(product.precio_clp)
    image = (
        f'<img class="catalog-image" src="{escape(image_url, quote=True)}" '
        f'alt="Imagen referencial de {escape(product.titulo, quote=True)}" loading="lazy" '
        'referrerpolicy="no-referrer">'
        if image_url
        else '<span class="catalog-image-placeholder">Imagen no disponible</span>'
    )
    fit_score = (
        f"{result.puntuacion:.6f}"
        if result and isfinite(result.puntuacion)
        else ""
    )
    fit_label = (
        f"Estimación: {result.diagnostico.etiqueta}"
        if result
        else "Sin referencia para comparar cintura y cadera"
    )
    fit_badge_label = (
        result.diagnostico.etiqueta
        if result
        else "Sin referencia de calce"
    )
    if result and result.diagnostico.etiqueta == "Ingresa tus medidas":
        fit_badge_label = "Ingresa tus medidas"
    elif result and result.diagnostico.etiqueta == "Revisión parcial":
        fit_badge_label = "Completa cintura y cadera"
    fit_badge_class = (
        result.diagnostico.clase_css
        if result and result.diagnostico.clase_css
        else "partial"
    )
    return f"""<article class="catalog-item" data-catalog-card
      data-catalog-id="{escape(product.id, quote=True)}"
      data-catalog-size="{escape(product.talla or 'No indicada', quote=True)}"
      data-catalog-bust="{escape(_format_measure(perfil.busto), quote=True)}"
      data-catalog-store="{escape(store, quote=True)}"
      data-catalog-brand="{escape(product.marca or 'No indicada', quote=True)}"
      data-catalog-fit-label="{escape(fit_label, quote=True)}"
      data-catalog-fit-badge="{escape(fit_badge_label, quote=True)}"
      data-catalog-reference="{escape(reference_label or 'Sin referencia', quote=True)}"
      data-catalog-price="{price_value}" data-catalog-fit-score="{fit_score}"
      data-catalog-index="{indice}" data-catalog-type="{escape(product.tipo_prenda, quote=True)}"
      data-catalog-try-on-category="{_virtual_try_on_category(product)}"
      data-catalog-searchable="{escape((store + ' ' + product.titulo + ' ' + product.marca + ' ' + product.categorias_catalogo).casefold(), quote=True)}">
      <label class="catalog-select">
        <input type="checkbox" data-catalog-select
          aria-label="Seleccionar {escape(product.titulo, quote=True)} para el Probador">
        <span>Seleccionar</span>
      </label>
      <span class="catalog-fit-badge {escape(fit_badge_class, quote=True)}"
        title="{escape(fit_label, quote=True)}">{escape(fit_badge_label)}</span>
      <a class="catalog-product-link" href="{escape(product.url, quote=True)}"
        target="_blank" rel="noopener noreferrer">{image}</a>
      <div class="catalog-item-info">
        <span class="catalog-brand">{escape(store)} · {escape(product.marca)} · {escape(product.tipo_prenda)}</span>
        <h3>{escape(product.titulo)}</h3>
        <span class="catalog-product-size">Talla publicada: {escape(product.talla or "No indicada")}</span>
        <strong class="catalog-price">{_format_price(product.precio_clp)}</strong>
        <span class="catalog-fit">{escape(fit_label)}</span>
        <a class="catalog-buy-link" href="{escape(product.url, quote=True)}"
          target="_blank" rel="noopener noreferrer">Ver ficha en {escape(store)}</a>
      </div>
    </article>"""


def _garment_catalog(
    perfil: PerfilMedidas,
    preferencia: str,
    visible: bool = False,
    query: Optional[Dict[str, str]] = None,
) -> str:
    query = query or {}
    catalog_data = _catalog_page_data(query, perfil, preferencia)
    type_options = _option("", "Todos los tipos", query.get("type", "")) + "".join(
        f'<optgroup label="{escape(group_label, quote=True)}">'
        + "".join(
            _option(product_type, product_type, query.get("type", ""))
            for product_type in grouped_types
        )
        + "</optgroup>"
        for group_label, grouped_types in _catalog_type_filter_groups(
            catalog_data["types"]
        )
        if grouped_types
    )
    size_options = _option("", "Todas las tallas", query.get("size", "")) + "".join(
        _option(size, size, query.get("size", ""))
        for size in catalog_data["sizes"]
    )
    brand_options = _option("", "Todas las marcas", query.get("brand", "")) + "".join(
        _option(brand, brand, query.get("brand", ""))
        for brand in catalog_data["brands"]
    )
    sort_options = "".join(
        _option(value, label, query.get("sort", "fit-asc"))
        for value, label in CATALOG_SORT_OPTIONS
    )
    page_number = catalog_data["page"] + 1
    page_count = catalog_data["pages"]
    visibility = "" if visible else " hidden"
    search_term = query.get("search", "").strip()
    heading = (
        f'Tus resultados de búsqueda para <strong>{escape(search_term)}</strong>'
        if search_term
        else "Catálogo completo de prendas"
    )
    return (
        '<section class="garment-catalog" id="garment-catalog" data-garment-catalog '
        f'data-catalog-page-index="{catalog_data["page"]}" '
        f'aria-labelledby="garment-catalog-title"{visibility}>'
        '<div class="catalog-shell">'
        '<div class="catalog-main">'
        '<div class="catalog-heading"><div>'
        f'<h2 id="garment-catalog-title" data-catalog-heading>{heading}</h2>'
        '<p class="catalog-result-count" data-catalog-result-count '
        f'aria-live="polite">{escape(catalog_data["result_text"])}</p></div>'
        '<div class="catalog-toolbar-actions">'
        '<button class="catalog-filter-trigger" type="button" '
        'data-catalog-open-filters aria-haspopup="dialog" '
        'aria-controls="catalog-filter-dialog" aria-expanded="false">'
        '<svg aria-hidden="true" viewBox="0 0 20 20"><path d="M3 5h14M5.5 10h9M8 15h4"/></svg>'
        '<span>Filtros</span><span class="catalog-filter-count" '
        'data-catalog-filter-count>0</span></button>'
        '<label class="catalog-sort-label" for="catalog-sort"><span>Ordenar por</span>'
        '<select id="catalog-sort" data-catalog-sort>'
        f'{sort_options}</select></label></div></div>'
        '<div class="catalog-view-bar"><span class="catalog-view-count">'
        f'{catalog_data["total"]} prendas</span>'
        '<div class="catalog-view-controls" role="group" aria-label="Vista de productos">'
        '<span>Vista</span>'
        '<button type="button" data-catalog-view="5" aria-label="Vista de cinco columnas" '
        'aria-pressed="true"><svg aria-hidden="true" viewBox="0 0 20 20">'
        '<path d="M2 3h4v14H2zM8 3h4v14H8zM14 3h4v14h-4z"/></svg></button>'
        '<button type="button" data-catalog-view="3" aria-label="Vista de tres columnas" '
        'aria-pressed="false"><svg aria-hidden="true" viewBox="0 0 20 20">'
        '<path d="M2 3h7v14H2zM11 3h7v14h-7z"/></svg></button>'
        '<button type="button" data-catalog-view="2" aria-label="Vista de dos columnas" '
        'aria-pressed="false"><svg aria-hidden="true" viewBox="0 0 20 20">'
        '<path d="M2 2h7v7H2zM11 2h7v7h-7zM2 11h7v7H2zM11 11h7v7h-7z"/></svg></button>'
        '</div></div>'
        '<form class="catalog-search-form" data-catalog-search-form action="/" method="get">'
        '<input type="hidden" name="view" value="catalog">'
        '<label class="visually-hidden" for="catalog-search">Buscar prendas</label>'
        '<input id="catalog-search" type="search" name="search" data-catalog-search '
        f'value="{escape(query.get("search", ""), quote=True)}" '
        'placeholder="Buscar prendas" autocomplete="off">'
        '<button type="submit">Buscar</button></form>'
        '<dialog class="catalog-filter-dialog" id="catalog-filter-dialog" '
        'data-catalog-filters-dialog aria-labelledby="catalog-filter-title">'
        '<div class="catalog-filter-dialog-content">'
        '<header class="catalog-filter-dialog-header"><h2 id="catalog-filter-title">Filtros</h2>'
        '<button type="button" data-catalog-clear-filters>Limpiar filtros</button>'
        '<button class="catalog-filter-close" type="button" '
        'data-catalog-close-filters aria-label="Cerrar filtros">×</button></header>'
        '<aside class="catalog-sidebar"><div class="catalog-filter-card"><div class="catalog-filters">'
        '<details class="catalog-filter-section" open><summary>Tipo de prenda</summary>'
        '<label class="catalog-filter-field"><span>Tipo</span><select data-catalog-type-filter>'
        f'{type_options}</select></label></details>'
        '<details class="catalog-filter-section"><summary>Talla</summary>'
        '<label class="catalog-filter-field"><span>Talla</span><select data-catalog-size-filter>'
        f'{size_options}</select></label></details>'
        '<details class="catalog-filter-section"><summary>Marca</summary>'
        '<label class="catalog-filter-field"><span>Marca</span><select data-catalog-brand-filter>'
        f'{brand_options}</select></label></details>'
        '<details class="catalog-filter-section"><summary>Precio</summary>'
        '<fieldset class="catalog-price-range"><legend>Rango en CLP</legend>'
        '<label>Desde<input type="number" min="0" step="1000" '
        f'data-catalog-min-price value="{escape(query.get("min_price", ""), quote=True)}"></label>'
        '<label>Hasta<input type="number" min="0" step="1000" '
        f'data-catalog-max-price value="{escape(query.get("max_price", ""), quote=True)}"></label>'
        '</fieldset></details></div></div></aside>'
        '<footer class="catalog-filter-dialog-footer"><button type="button" '
        'data-catalog-apply-filters '
        f'data-catalog-total="{catalog_data["total"]}">'
        f'Mostrar {catalog_data["total"]} productos</button></footer>'
        '</div></dialog>'
        f'<div class="catalog-grid" data-catalog-items '
        f'data-catalog-page-size="{CATALOG_PAGE_SIZE}" data-view="5">'
        f'{catalog_data["cards"]}</div>'
        '<nav class="catalog-pagination" data-catalog-pagination '
        'aria-label="Paginación del catálogo">'
        f'<button type="button" data-catalog-previous'
        f'{" disabled" if page_number <= 1 else ""}>← Anterior</button>'
        f'<span data-catalog-page aria-live="polite">'
        f'{escape(catalog_data["page_text"])}</span>'
        '<button type="button" data-catalog-next'
        f'{" disabled" if page_number >= page_count else ""}>Siguiente →</button>'
        '</nav>'
        '<div class="catalog-selection-bar" data-catalog-selection-bar hidden>'
        '<span data-catalog-selection-status aria-live="polite">Ninguna prenda seleccionada</span>'
        '<button class="catalog-try-on-button" type="button" data-catalog-try-on '
        'disabled>Selecciona prendas para probarte</button></div>'
        '</div></div></section>'
    )


def _virtual_try_on_panel() -> str:
    return (
        '<section class="try-on-panel" data-virtual-try-on '
        'aria-labelledby="virtual-try-on-title">'
        '<header class="try-on-heading">'
        '<div><span class="eyebrow">Prueba con tu foto</span>'
        '<h1 id="virtual-try-on-title">Probador</h1></div>'
        '</header>'
        '<div class="try-on-layout">'
        '<div class="try-on-person">'
        '<h2>Foto de Inicio</h2>'
        '<img data-vton-person-preview alt="Foto seleccionada en Inicio" hidden>'
        '<p data-vton-person-empty>No hay una foto seleccionada en esta sesión. '
        '<a href="/" data-vton-return-home>Ve a Inicio y selecciona una foto.</a></p>'
        '</div>'
        '<div class="try-on-output" data-vton-output aria-live="polite">'
        '<figure class="try-on-result" data-vton-result hidden>'
        '<figcaption data-vton-result-status></figcaption>'
        '<img data-vton-result-image alt="Resultado de la prueba virtual">'
        '</figure>'
        '</div></div>'
        '<div class="try-on-controls">'
        '<span class="try-on-product-label" id="vton-product-list-label">'
        'Prendas</span>'
        '<div class="try-on-product-list" data-vton-product-list '
        'aria-labelledby="vton-product-list-label">'
        '<section class="try-on-product-group" '
        'data-vton-product-group="upper_body" '
        'aria-labelledby="vton-upper-products-label">'
        '<h3 id="vton-upper-products-label">Prendas superiores</h3>'
        '<div class="try-on-product-options" '
        'data-vton-product-options="upper_body"></div>'
        '</section>'
        '<section class="try-on-product-group" '
        'data-vton-product-group="lower_body" '
        'aria-labelledby="vton-lower-products-label">'
        '<h3 id="vton-lower-products-label">Prendas inferiores</h3>'
        '<div class="try-on-product-options" '
        'data-vton-product-options="lower_body"></div>'
        '</section>'
        '</div>'
        '<p class="try-on-selection-hint">Puedes combinar una prenda '
        'superior y una inferior.</p>'
        '<label class="try-on-provider-label" for="vton-provider">'
        'Proveedor de prueba'
        '<select id="vton-provider" data-vton-provider>'
        '<option value="automatic">Automático</option>'
        '<option value="rapidapi">Try on Clothes Pro</option>'
        '<option value="datatobiz">DataToBiz</option>'
        '<option value="diffusion">Try-On Diffusion</option>'
        '<option value="refiner">Try on Clothes Refiner</option>'
        '</select>'
        '</label>'
        '<p class="try-on-provider-hint" id="vton-provider-help">'
        'DataToBiz admite una sola prenda superior.</p>'
        '<label class="try-on-provider-label" data-vton-gender-field hidden>'
        'Género para Clothes Refiner'
        '<select data-vton-gender>'
        '<option value="woman" selected>Mujer</option>'
        '<option value="man">Hombre</option>'
        '</select>'
        '</label>'
        '<select id="vton-product-select" data-vton-product-select multiple '
        'hidden aria-hidden="true" tabindex="-1">'
        '<option value="">Selecciona una prenda desde Catálogo</option>'
        '</select>'
        '<div class="try-on-hover-tooltip" data-vton-garment-tooltip '
        'role="tooltip" hidden>'
        '<img data-vton-tooltip-image alt="">'
        '<span data-vton-tooltip-title></span>'
        '</div>'
        '<button class="matices-button matices-button-primary" type="button" '
        'data-vton-generate disabled>Probar</button>'
        '</div>'
        '<p class="try-on-status" data-vton-status role="status" aria-live="polite"></p>'
        '</section>'
    )


def _catalog_page_data(
    query: Dict[str, str],
    perfil: Optional[PerfilMedidas] = None,
    preferencia: Optional[str] = None,
) -> Dict[str, object]:
    perfil = perfil or PerfilMedidas.desde_formulario(
        {
            "bust": query.get("bust"),
            "waist": query.get("waist"),
            "hip": query.get("hip"),
        }
    )
    preferencia = preferencia or query.get("preference", "regular")
    recommendations = _catalog_recommendations(perfil, preferencia)
    types = tuple(
        sorted(
            {
                product.tipo_prenda
                for product in CATALOG_PRODUCTS
                if _normalize_search_text(product.tipo_prenda)
                not in EXCLUDED_CATALOG_FILTER_TYPES
            },
            key=str.casefold,
        )
    )
    sizes = tuple(
        sorted(
            {product.talla or "No indicada" for product in CATALOG_PRODUCTS},
            key=str.casefold,
        )
    )
    brands = tuple(
        sorted(
            {product.marca or "No indicada" for product in CATALOG_PRODUCTS},
            key=str.casefold,
        )
    )
    normalized_search = _normalize_search_text(query.get("search", ""))
    selected_type = query.get("type", "")
    if selected_type not in types:
        selected_type = ""
    selected_size = query.get("size", "")
    selected_brand = query.get("brand", "")
    try:
        min_price = max(0, int(query["min_price"])) if query.get("min_price") else None
    except ValueError:
        min_price = None
    try:
        max_price = max(0, int(query["max_price"])) if query.get("max_price") else None
    except ValueError:
        max_price = None
    filtered = []
    for index, (product, reference, reference_label, result) in enumerate(
        recommendations
    ):
        searchable = CATALOG_SEARCH_TEXT_BY_URL[product.url]
        if selected_type and selected_type != product.tipo_prenda:
            continue
        if selected_size and selected_size != (product.talla or "No indicada"):
            continue
        if selected_brand and selected_brand != (product.marca or "No indicada"):
            continue
        if min_price is not None and (
            product.precio_clp is None or product.precio_clp < min_price
        ):
            continue
        if max_price is not None and (
            product.precio_clp is None or product.precio_clp > max_price
        ):
            continue
        if normalized_search and normalized_search not in searchable:
            continue
        filtered.append((index, product, reference, reference_label, result))

    sort_option = query.get("sort", "fit-asc")
    if sort_option not in {value for value, _ in CATALOG_SORT_OPTIONS}:
        sort_option = "fit-asc"
    sort_by_price = sort_option.startswith("price")
    direction = -1 if sort_option.endswith("desc") else 1

    def sort_key(item):
        index, product, _, _, result = item
        value = (
            product.precio_clp
            if sort_by_price
            else result.puntuacion if result is not None else None
        )
        missing = value is None or (sort_by_price and value <= 0)
        return (
            missing,
            (value or 0) * direction,
            index,
        )

    if sort_option != "fit-asc":
        filtered.sort(key=sort_key)
    try:
        requested_page = max(0, int(query.get("page", "0")))
    except ValueError:
        requested_page = 0
    total = len(filtered)
    page_count = (total + CATALOG_PAGE_SIZE - 1) // CATALOG_PAGE_SIZE
    page = min(requested_page, max(0, page_count - 1))
    start = page * CATALOG_PAGE_SIZE
    visible = filtered[start : start + CATALOG_PAGE_SIZE]
    cards = "".join(
        _catalog_product_card(
            product,
            reference,
            result,
            reference_label,
            index,
            preferencia,
            perfil,
        )
        for index, product, reference, reference_label, result in visible
    )
    result_text = (
        f"Mostrando {start + 1}–{min(start + CATALOG_PAGE_SIZE, total)} de "
        f"{total} prendas"
        if total
        else f"No se encontraron prendas entre {len(CATALOG_PRODUCTS)} fichas"
    )
    return {
        "cards": cards,
        "types": types,
        "sizes": sizes,
        "brands": brands,
        "total": total,
        "page": page,
        "pages": page_count,
        "result_text": result_text,
        "page_text": f"Página {page + 1} de {page_count}" if page_count else "Sin páginas",
    }


def _virtual_try_on_products(
    search: str,
    product_urls: Tuple[str, ...] = (),
) -> Dict[str, object]:
    normalized_search = _normalize_search_text(search.strip())
    requested_urls = set(product_urls)
    products = []
    for product in CATALOG_PRODUCTS:
        if requested_urls and product.url not in requested_urls:
            continue
        if (
            normalized_search
            and normalized_search not in CATALOG_SEARCH_TEXT_BY_URL[product.url]
        ):
            continue
        image_url = CATALOG_IMAGES_BY_URL.get(product.url, "")
        products.append(
            {
                "product_url": product.url,
                "title": product.titulo,
                "brand": product.marca,
                "store": CATALOG_STORES_BY_URL.get(product.url, "Vestua"),
                "size": product.talla or "No indicada",
                "image_url": image_url,
                "category": _virtual_try_on_category(product),
            }
        )
        if not requested_urls and len(products) == 24:
            break
    return {"products": products}


def _supabase_user_for_token(access_token: str) -> object:
    request = Request(
        f"{SUPABASE_URL}/auth/v1/user",
        headers={
            "apikey": SUPABASE_PUBLISHABLE_KEY,
            "Authorization": f"Bearer {access_token}",
        },
    )
    with urlopen(request, timeout=10) as response:
        return json.loads(response.read(65536).decode("utf-8"))


def _download_catalog_image(image_url: str) -> bytes:
    parsed_url = urlparse(image_url)
    if parsed_url.scheme != "https" or not parsed_url.netloc:
        raise ValueError("La imagen del catálogo no tiene una URL segura.")
    request = Request(image_url, headers={"User-Agent": "CalceMatices/1.0"})
    with urlopen(request, timeout=30) as response:
        image = response.read(MAX_CATALOG_IMAGE_BYTES + 1)
    if len(image) > MAX_CATALOG_IMAGE_BYTES:
        raise ValueError("La imagen del catálogo supera el límite permitido.")
    if not image:
        raise ValueError("No se pudo descargar la imagen del catálogo.")
    return image


def _prepare_rapidapi_image(image_bytes: bytes, label: str) -> bytes:
    from PIL import Image, ImageOps, UnidentifiedImageError

    try:
        with Image.open(io.BytesIO(image_bytes)) as source:
            if max(source.size) > 4096:
                raise ValueError(
                    f"{label} no puede superar 4096 píxeles por lado."
                )
            image = ImageOps.exif_transpose(source)
            if min(image.size) < 150:
                raise ValueError(
                    f"{label} debe medir al menos 150 × 150 píxeles."
                )
            if "A" in image.getbands() or "transparency" in image.info:
                rgba = image.convert("RGBA")
                image = Image.new("RGB", rgba.size, "white")
                image.paste(rgba, mask=rgba.getchannel("A"))
            else:
                image = image.convert("RGB")
            image.thumbnail((2048, 2048), Image.Resampling.LANCZOS)
            for quality in (85, 75, 65):
                output = io.BytesIO()
                image.save(
                    output,
                    format="JPEG",
                    quality=quality,
                    optimize=True,
                )
                prepared_image = output.getvalue()
                if len(prepared_image) <= MAX_RAPIDAPI_IMAGE_BYTES:
                    return prepared_image
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError) as error:
        raise ValueError(f"{label} no es una imagen compatible.") from error
    raise ValueError(f"{label} supera el límite de 5 MB.")


def _upper_body_reference_image(person_image: bytes) -> bytes:
    from PIL import Image, ImageOps

    with Image.open(io.BytesIO(person_image)) as source:
        image = ImageOps.exif_transpose(source)
        width, height = image.size
        crop = image.crop(
            (
                round(width * 0.15),
                round(height * 0.18),
                round(width * 0.85),
                round(height * 0.66),
            )
        ).convert("RGB")
        if min(crop.size) < 150:
            scale = max(150 / crop.width, 150 / crop.height)
            crop = crop.resize(
                (
                    round(crop.width * scale),
                    round(crop.height * scale),
                ),
                Image.Resampling.LANCZOS,
            )
        output = io.BytesIO()
        crop.save(output, format="JPEG", quality=85, optimize=True)
    return _prepare_rapidapi_image(
        output.getvalue(),
        "La referencia superior recortada",
    )


def _read_rapidapi_json(response) -> Dict[str, object]:
    response_body = response.read(MAX_RAPIDAPI_RESPONSE_BYTES + 1)
    if len(response_body) > MAX_RAPIDAPI_RESPONSE_BYTES:
        raise ValueError("RapidAPI devolvió una respuesta demasiado grande.")
    try:
        result = json.loads(response_body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError("RapidAPI devolvió una respuesta inválida.") from error
    if not isinstance(result, dict):
        raise ValueError("RapidAPI devolvió una respuesta inválida.")
    error_code = result.get("error_code")
    if error_code not in (0, "0"):
        error_message = result.get("error_msg")
        detail = (
            error_message.strip()[:200]
            if isinstance(error_message, str) and error_message.strip()
            else f"código {error_code}"
        )
        raise ValueError(f"RapidAPI no pudo procesar la tarea ({detail}).")
    return result


def _rapidapi_http_error_detail(error: HTTPError) -> str:
    try:
        body = error.read(4096).decode("utf-8", errors="replace").strip()
    except OSError:
        return ""
    if not body:
        return ""
    try:
        payload = json.loads(body)
    except json.JSONDecodeError:
        return body[:240]
    if isinstance(payload, dict):
        for key in ("message", "error", "detail", "error_msg", "description"):
            detail = payload.get(key)
            if isinstance(detail, str) and detail.strip():
                return detail.strip()[:240]
    return body[:240]


def _rapidapi_task_result_for(
    task_id: str,
    host: str,
    api_key: str,
    endpoint: str,
    provider_name: str,
) -> str:
    deadline = time.monotonic() + RAPIDAPI_TASK_TIMEOUT_SECONDS
    poll_count = 0
    request_url = (
        f"{endpoint}?"
        f"{urlencode({'task_id': task_id})}"
    )
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError(
                f"{provider_name} tardó demasiado en generar la imagen."
            )
        request = Request(
            request_url,
            headers={
                "x-rapidapi-key": api_key,
                "x-rapidapi-host": host,
                "Accept": "application/json",
            },
        )
        with urlopen(request, timeout=min(20, remaining)) as response:
            result = _read_rapidapi_json(response)
        task_status = result.get("task_status")
        if task_status == 2:
            output = result.get("output")
            image_url = (
                output.get("image_url")
                if isinstance(output, dict)
                else None
            )
            parsed_url = (
                urlparse(image_url)
                if isinstance(image_url, str)
                else None
            )
            if (
                not parsed_url
                or parsed_url.scheme != "https"
                or not parsed_url.netloc
            ):
                raise ValueError(
                    f"{provider_name} no devolvió una URL de imagen válida."
                )
            return image_url
        if task_status not in (0, 1):
            raise ValueError(
                f"{provider_name} devolvió un estado de tarea inesperado."
            )
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError(
                f"{provider_name} tardó demasiado en generar la imagen."
            )
        poll_interval = (
            RAPIDAPI_EARLY_POLL_INTERVALS_SECONDS[poll_count]
            if poll_count < len(RAPIDAPI_EARLY_POLL_INTERVALS_SECONDS)
            else RAPIDAPI_POLL_INTERVAL_SECONDS
        )
        time.sleep(min(poll_interval, remaining))
        poll_count += 1


def _rapidapi_task_result(task_id: str) -> str:
    return _rapidapi_task_result_for(
        task_id,
        RAPIDAPI_HOST,
        RAPIDAPI_KEY,
        RAPIDAPI_TASK_RESULT_ENDPOINT,
        "Try on Clothes Pro",
    )


def _prepare_rapidapi_garment_files(
    person_image: bytes,
    products: Tuple[ProductoVestua, ...],
) -> Dict[str, Tuple[str, bytes, str]]:
    categories = {
        _virtual_try_on_category(product): product
        for product in products
    }
    if len(products) == 2 and set(categories) != {"upper_body", "lower_body"}:
        raise ValueError("Combina una prenda superior con una inferior.")
    if len(products) == 1 and not set(categories).issubset(
        {"upper_body", "lower_body", "dresses"}
    ):
        raise ValueError("El Probador solo admite prendas superiores, inferiores o vestidos.")
    if len(products) not in (1, 2):
        raise ValueError("Selecciona una prenda superior y una inferior como máximo.")

    def prepare_selected_garment(product: ProductoVestua, label: str) -> bytes:
        product_image_url = CATALOG_IMAGES_BY_URL.get(product.url)
        if not product_image_url:
            raise ValueError(f"{label} no tiene una imagen disponible.")
        return _prepare_rapidapi_image(
            _download_catalog_image(product_image_url),
            label,
        )

    files: Dict[str, Tuple[str, bytes, str]] = {}
    top_product = categories.get("upper_body") or categories.get("dresses")
    bottom_product = categories.get("lower_body")
    if bottom_product and not top_product:
        top_garment = _upper_body_reference_image(person_image)
        files["top_garment"] = ("top-garment.jpg", top_garment, "image/jpeg")

    garment_jobs = []
    if top_product:
        garment_jobs.append(
            ("top_garment", "top-garment.jpg", top_product, "La prenda superior")
        )
    if bottom_product:
        garment_jobs.append(
            (
                "bottom_garment",
                "bottom-garment.jpg",
                bottom_product,
                "La prenda inferior",
            )
        )
    if len(garment_jobs) == 2:
        with ThreadPoolExecutor(max_workers=2) as executor:
            futures = [
                executor.submit(prepare_selected_garment, job[2], job[3])
                for job in garment_jobs
            ]
            for job, future in zip(garment_jobs, futures):
                files[job[0]] = (job[1], future.result(), "image/jpeg")
    else:
        for field, filename, product, label in garment_jobs:
            files[field] = (
                filename,
                prepare_selected_garment(product, label),
                "image/jpeg",
            )
    return files


def _rapidapi_try_on_with_garments(
    person_image: bytes,
    garment_files: Dict[str, Tuple[str, bytes, str]],
) -> Dict[str, str]:
    files = {
        "person_image": ("person.jpg", person_image, "image/jpeg"),
        **garment_files,
    }
    body, boundary = _multipart_form(
        {"task_type": "async", "resolution": "1024"},
        files,
    )
    request = Request(
        RAPIDAPI_ENDPOINT,
        data=body,
        headers={
            "x-rapidapi-key": RAPIDAPI_KEY,
            "x-rapidapi-host": RAPIDAPI_HOST,
            "Content-Type": f"multipart/form-data; boundary={boundary}",
            "Accept": "application/json",
        },
        method="POST",
    )
    with urlopen(request, timeout=30) as response:
        result = _read_rapidapi_json(response)
    task_id = result.get("task_id")
    if not isinstance(task_id, str) or not task_id:
        raise ValueError("RapidAPI no devolvió un identificador de tarea.")
    return {"result_image_url": _rapidapi_task_result(task_id)}


def _rapidapi_try_on(
    person_image: bytes,
    products: Tuple[ProductoVestua, ...],
) -> Dict[str, str]:
    return _rapidapi_try_on_with_garments(
        person_image,
        _prepare_rapidapi_garment_files(person_image, products),
    )


def _multipart_form(
    fields: Dict[str, str],
    files: Dict[str, Tuple[str, bytes, str]],
) -> Tuple[bytes, str]:
    boundary = f"----CalceMatices{uuid.uuid4().hex}"
    parts = []
    for name, value in fields.items():
        parts.extend(
            (
                f"--{boundary}\r\n".encode("ascii"),
                (
                    f'Content-Disposition: form-data; name="{name}"\r\n\r\n'
                ).encode("ascii"),
                value.encode("utf-8"),
                b"\r\n",
            )
        )
    for name, (filename, content, content_type) in files.items():
        parts.extend(
            (
                f"--{boundary}\r\n".encode("ascii"),
                (
                    f'Content-Disposition: form-data; name="{name}"; '
                    f'filename="{filename}"\r\n'
                ).encode("ascii"),
                f"Content-Type: {content_type}\r\n\r\n".encode("ascii"),
                content,
                b"\r\n",
            )
        )
    parts.append(f"--{boundary}--\r\n".encode("ascii"))
    return b"".join(parts), boundary


def _image_mime_type(image: bytes) -> Optional[str]:
    if image.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if image.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if image.startswith(b"RIFF") and image[8:12] == b"WEBP":
        return "image/webp"
    return None


def _datatobiz_result_source(value: object) -> Optional[Tuple[str, str]]:
    if isinstance(value, dict):
        for key in ("result_image_url", "image_url", "imageUrl", "output_url", "url"):
            image_url = value.get(key)
            if isinstance(image_url, str):
                parsed_url = urlparse(image_url)
                if parsed_url.scheme == "https" and parsed_url.netloc:
                    return "result_image_url", image_url
        for key in (
            "result_image",
            "image_base64",
            "image",
            "output",
            "result",
            "data",
        ):
            source = _datatobiz_result_source(value.get(key))
            if source:
                return source
    elif isinstance(value, str):
        if value.startswith("data:image/"):
            mime_type, separator, encoded_image = value.partition(";base64,")
            if separator and mime_type in {
                "data:image/jpeg",
                "data:image/png",
                "data:image/webp",
            }:
                try:
                    image = base64.b64decode(encoded_image, validate=True)
                except (binascii.Error, ValueError):
                    return None
                detected_mime_type = _image_mime_type(image)
                if detected_mime_type == mime_type[5:]:
                    return "result_image_data_url", value
        parsed_url = urlparse(value)
        if parsed_url.scheme == "https" and parsed_url.netloc:
            return "result_image_url", value
        try:
            image = base64.b64decode(value, validate=True)
        except (binascii.Error, ValueError):
            return None
        mime_type = _image_mime_type(image)
        if mime_type:
            image_data_url = (
                f"data:{mime_type};base64,"
                f"{base64.b64encode(image).decode('ascii')}"
            )
            return "result_image_data_url", image_data_url
    return None


def _datatobiz_response_source(response) -> Tuple[str, str]:
    response_body = response.read(MAX_DATATOBIZ_RESPONSE_BYTES + 1)
    if len(response_body) > MAX_DATATOBIZ_RESPONSE_BYTES:
        raise ValueError("DataToBiz devolvió una respuesta demasiado grande.")
    content_type = response.headers.get("Content-Type", "").split(";", 1)[0].lower()
    mime_type = _image_mime_type(response_body)
    if mime_type and (
        content_type == mime_type
        or content_type == "application/octet-stream"
    ):
        return (
            "result_image_data_url",
            f"data:{mime_type};base64,"
            f"{base64.b64encode(response_body).decode('ascii')}",
        )
    if content_type.startswith("image/"):
        raise ValueError("DataToBiz devolvió un formato de imagen no compatible.")
    try:
        payload = json.loads(response_body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        payload = response_body.decode("utf-8", errors="replace").strip()
    image_source = _datatobiz_result_source(payload)
    if image_source:
        return image_source
    raise ValueError("DataToBiz no devolvió una imagen en un formato reconocido.")


def _datatobiz_try_on(
    person_image: bytes,
    product: ProductoVestua,
) -> Dict[str, str]:
    product_image_url = CATALOG_IMAGES_BY_URL.get(product.url)
    if not product_image_url:
        raise ValueError("La prenda superior no tiene una imagen disponible.")
    garment_image = _prepare_rapidapi_image(
        _download_catalog_image(product_image_url),
        "La prenda superior",
    )
    body, boundary = _multipart_form(
        {},
        {
            "personImage": ("person.jpg", person_image, "image/jpeg"),
            "clothImage": ("cloth.jpg", garment_image, "image/jpeg"),
        },
    )
    request = Request(
        DATATOBIZ_RAPIDAPI_ENDPOINT,
        data=body,
        headers={
            "x-rapidapi-key": DATATOBIZ_RAPIDAPI_KEY,
            "x-rapidapi-host": DATATOBIZ_RAPIDAPI_HOST,
            "Content-Type": f"multipart/form-data; boundary={boundary}",
            "Accept": "application/json, image/*",
        },
        method="POST",
    )
    with urlopen(request, timeout=180) as response:
        source_key, image_source = _datatobiz_response_source(response)
    return {source_key: image_source}


def _try_on_diffusion_response_source(response) -> Tuple[str, str]:
    response_body = response.read(MAX_DATATOBIZ_RESPONSE_BYTES + 1)
    if len(response_body) > MAX_DATATOBIZ_RESPONSE_BYTES:
        raise ValueError("Try-On Diffusion devolvió una respuesta demasiado grande.")
    content_type = response.headers.get("Content-Type", "").split(";", 1)[0].lower()
    mime_type = _image_mime_type(response_body)
    if mime_type and (
        content_type == mime_type
        or content_type == "application/octet-stream"
    ):
        return (
            "result_image_data_url",
            f"data:{mime_type};base64,"
            f"{base64.b64encode(response_body).decode('ascii')}",
        )
    if content_type.startswith("image/"):
        raise ValueError("Try-On Diffusion devolvió una imagen no compatible.")
    try:
        payload = json.loads(response_body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        payload = response_body.decode("utf-8", errors="replace").strip()
    image_source = _datatobiz_result_source(payload)
    if image_source:
        return image_source
    raise ValueError("Try-On Diffusion no devolvió una imagen reconocible.")


def _try_on_diffusion(
    person_image: bytes,
    product: ProductoVestua,
) -> Dict[str, str]:
    product_image_url = CATALOG_IMAGES_BY_URL.get(product.url)
    if not product_image_url:
        raise ValueError("La prenda seleccionada no tiene una imagen disponible.")
    garment_image = _prepare_rapidapi_image(
        _download_catalog_image(product_image_url),
        "La prenda seleccionada",
    )
    body, boundary = _multipart_form(
        {},
        {
            "avatar_image": ("avatar.jpg", person_image, "image/jpeg"),
            "clothing_image": ("clothing.jpg", garment_image, "image/jpeg"),
        },
    )
    request = Request(
        DIFFUSION_RAPIDAPI_ENDPOINT,
        data=body,
        headers={
            "x-rapidapi-key": RAPIDAPI_DIFFUSION_KEY,
            "x-rapidapi-host": DIFFUSION_RAPIDAPI_HOST,
            "Content-Type": f"multipart/form-data; boundary={boundary}",
            "Accept": "application/json, image/*",
        },
        method="POST",
    )
    with urlopen(request, timeout=180) as response:
        source_key, image_source = _try_on_diffusion_response_source(response)
    return {source_key: image_source}


def _try_on_clothes_refiner(
    person_image: bytes,
    coarse_image_url: str,
    products: Tuple[ProductoVestua, ...],
    gender: str,
) -> Dict[str, str]:
    return _try_on_clothes_refiner_with_garments(
        person_image,
        coarse_image_url,
        gender,
        _prepare_rapidapi_garment_files(person_image, products),
    )


def _try_on_clothes_refiner_with_garments(
    person_image: bytes,
    coarse_image_url: str,
    gender: str,
    garment_files: Dict[str, Tuple[str, bytes, str]],
) -> Dict[str, str]:
    coarse_image = _prepare_rapidapi_image(
        _download_catalog_image(coarse_image_url),
        "El resultado preliminar",
    )
    files = {
        "coarse_image": ("coarse.jpg", coarse_image, "image/jpeg"),
        "person_image": ("person.jpg", person_image, "image/jpeg"),
        **garment_files,
    }
    body, boundary = _multipart_form(
        {"task_type": "async", "gender": gender},
        files,
    )
    request = Request(
        REFINER_RAPIDAPI_ENDPOINT,
        data=body,
        headers={
            "x-rapidapi-key": RAPIDAPI_REFINER_KEY,
            "x-rapidapi-host": REFINER_RAPIDAPI_HOST,
            "Content-Type": f"multipart/form-data; boundary={boundary}",
            "Accept": "application/json",
        },
        method="POST",
    )
    with urlopen(request, timeout=30) as response:
        result = _read_rapidapi_json(response)
    task_id = result.get("task_id")
    if not isinstance(task_id, str) or not task_id:
        raise ValueError(
            "Try on Clothes Refiner no devolvió un identificador de tarea."
        )
    result_image_url = _rapidapi_task_result_for(
        task_id,
        REFINER_RAPIDAPI_HOST,
        RAPIDAPI_REFINER_KEY,
        REFINER_RAPIDAPI_TASK_RESULT_ENDPOINT,
        "Try on Clothes Refiner",
    )
    return {"result_image_url": result_image_url}


def _supports_datatobiz_fallback(
    products: Tuple[ProductoVestua, ...],
) -> bool:
    return (
        len(products) == 1
        and _virtual_try_on_category(products[0]) == "upper_body"
    )


def _try_on_with_fallback(
    person_image: bytes,
    products: Tuple[ProductoVestua, ...],
) -> Dict[str, str]:
    primary_error = None
    if RAPIDAPI_KEY:
        try:
            return _rapidapi_try_on(person_image, products)
        except (
            HTTPError,
            URLError,
            TimeoutError,
            OSError,
            IncompleteRead,
            ValueError,
        ) as error:
            primary_error = error

    fallback_key = DATATOBIZ_RAPIDAPI_KEY
    if _supports_datatobiz_fallback(products) and fallback_key:
        try:
            result = _datatobiz_try_on(person_image, products[0])
        except (
            HTTPError,
            URLError,
            TimeoutError,
            OSError,
            IncompleteRead,
            ValueError,
        ) as fallback_error:
            if primary_error:
                raise TryOnProvidersError(primary_error, fallback_error) from fallback_error
            raise
        result["detail"] = "Resultado Probador (respaldo DataToBiz)"
        return result

    if primary_error:
        raise primary_error
    raise ValueError(
        "Configura RAPIDAPI_KEY para usar Try on Clothes Pro. DataToBiz solo "
        "admite una prenda superior individual como alternativa."
    )


@lru_cache(maxsize=8)
def _catalog_recommendations(
    perfil: PerfilMedidas,
    preferencia: str,
) -> Tuple[
    Tuple[ProductoVestua, Optional[Prenda], str, Optional[ResultadoCalce]], ...
]:
    return tuple(sorted(
        (
            (
                product,
                reference,
                reference_label,
                _calculate_fit(reference, perfil, preferencia)
                if reference is not None
                else None,
            )
            for product in CATALOG_PRODUCTS
            for reference, reference_label in (_reference_for_listing(product),)
        ),
        key=lambda item: (
            item[3].puntuacion if item[3] is not None else float("inf"),
            item[0].id,
        ),
    ))


def _size_ranges() -> str:
    ranges = "".join(
        (
            '<span data-standard-size '
            f'data-size-label="{escape(talla.etiqueta, quote=True)}" '
            f'data-size-eu="{escape(talla.europea or "", quote=True)}" '
            f'data-size-us="{escape(talla.estadounidense or "", quote=True)}" '
            f'data-size-bust-min="{talla.limites("busto")[0]}" '
            f'data-size-bust-max="{talla.limites("busto")[1]}" '
            f'data-size-waist-min="{talla.limites("cintura")[0]}" '
            f'data-size-waist-max="{talla.limites("cintura")[1]}" '
            f'data-size-hip-min="{talla.limites("cadera")[0]}" '
            f'data-size-hip-max="{talla.limites("cadera")[1]}"></span>'
        )
        for talla in STANDARD_SIZES
    )
    return f'<div data-standard-size-ranges hidden>{ranges}</div>'


def _format_measure(value: Optional[float]) -> str:
    return "Ingresa medida" if value is None else f"{value:.1f} cm"


def _format_difference(value: Optional[float]) -> str:
    if value is None:
        return "—"
    return f"{'+' if value > 0 else ''}{value:.1f} cm"


def _render_measure(measure) -> str:
    return f"""<div class="measure-card">
      <strong>{escape(measure.nombre)}</strong>
      <div class="metric"><span>Prenda</span><b>{_format_measure(measure.prenda)}</b></div>
      <div class="metric"><span>Tu cuerpo</span><b>{_format_measure(measure.cuerpo)}</b></div>
      <div class="metric"><span>Holgura</span><b>{_format_difference(measure.holgura)}</b></div>
    </div>"""


def _fit_explanation(
    resultado: ResultadoCalce,
    preferencia: str,
    elasticidad: float,
    tolerancia: float,
) -> str:
    minimum, maximum, _ = {
        "adjusted": (0, 4, 2),
        "regular": (2, 8, 5),
        "loose": (6, 14, 10),
    }.get(preferencia, (2, 8, 5))
    if elasticidad >= 8:
        minimum = max(minimum, -1)

    entered = tuple(measure for measure in resultado.medidas if measure.cuerpo is not None)
    missing = tuple(
        measure.nombre.lower()
        for measure in resultado.medidas
        if measure.cuerpo is None
    )
    if not entered:
        return "Ingresa tus medidas para comparar tu cuerpo con las medidas de esta prenda."
    if missing:
        comparison = "; ".join(
            f"{measure.nombre.lower()}: holgura {_format_difference(measure.holgura)}"
            for measure in entered
        )
        return (
            f"Revisión parcial: faltan tus medidas de {', '.join(missing)}. "
            f"Con lo ingresado, {comparison}. Completa las medidas para una comparación más completa."
        )

    status = resultado.diagnostico.etiqueta
    comparison = "; ".join(
        f"{measure.nombre.lower()}: prenda {_format_measure(measure.prenda)}, "
        f"tu cuerpo {_format_measure(measure.cuerpo)}, "
        f"holgura {_format_difference(measure.holgura)}"
        for measure in entered
    )
    if status == "Podría quedarte bien":
        reason = (
            f"Las holguras están dentro del rango orientativo de "
            f"{minimum:g} a {maximum:g} cm para el calce que elegiste."
        )
    elif status == "Podría quedar estrecha":
        affected = tuple(
            measure
            for measure in entered
            if measure.holgura < minimum - tolerancia
        )
        details = " y ".join(
            f"{measure.nombre.lower()} ({_format_difference(measure.holgura)})"
            for measure in affected
        )
        reason = (
            f"Podría quedar estrecha: las holguras de {details or 'una o más medidas'} "
            f"quedan por debajo del mínimo orientativo de {minimum:g} cm, "
            "incluso considerando la tolerancia de corte."
        )
    elif status == "Podría quedar holgada":
        affected = tuple(
            measure
            for measure in entered
            if measure.holgura > maximum + tolerancia
        )
        details = " y ".join(
            f"{measure.nombre.lower()} ({_format_difference(measure.holgura)})"
            for measure in affected
        )
        reason = (
            f"Podría quedar holgada: las holguras de {details or 'una o más medidas'} "
            f"superan el máximo orientativo de {maximum:g} cm, "
            "incluso considerando la tolerancia de corte."
        )
    elif status == "Ajuste al límite":
        affected = " y ".join(
            f"{measure.nombre.lower()} ({_format_difference(measure.holgura)})"
            for measure in entered
            if measure.holgura < minimum
        )
        reason = (
            f"Las holguras de {affected or 'una o más medidas'} están cerca del mínimo de {minimum:g} cm; "
            "el resultado puede variar dentro de la tolerancia de corte."
        )
    elif status == "Holgura al límite":
        affected = " y ".join(
            f"{measure.nombre.lower()} ({_format_difference(measure.holgura)})"
            for measure in entered
            if measure.holgura > maximum
        )
        reason = (
            f"Las holguras de {affected or 'una o más medidas'} están cerca del máximo de {maximum:g} cm; "
            "el resultado puede variar dentro de la tolerancia de corte."
        )
    else:
        reason = "La clasificación es orientativa; revisa los valores comparados."
    return f"{reason} Comparación: {comparison}. No garantiza el calce real."


def _render_product(
    prenda,
    resultado: ResultadoCalce,
    indice: int,
    preferencia: str,
) -> str:
    es_primera = indice == 0
    badge = resultado.diagnostico.etiqueta
    measures = "".join(_render_measure(measure) for measure in resultado.medidas)
    image = VESTUA_IMAGES.get(prenda.marca, {}).get(prenda.categoria, {})
    image_url = image.get("image_url", "")
    image_product_url = image.get("product_url", prenda.fuente)
    image_title = image.get("product_title", f"{prenda.categoria} {prenda.marca}")
    product_size = image.get("product_size", "")
    image_markup = (
        f'<a class="product-image-link" href="{escape(image_product_url, quote=True)}" '
        f'target="_blank" rel="noopener noreferrer" '
        f'aria-label="Ver referencia de {escape(prenda.marca, quote=True)} '
        f'{escape(prenda.categoria, quote=True)} en Vestua">'
        f'<img class="product-image" src="{escape(image_url, quote=True)}" '
        f'alt="Imagen referencial de {escape(image_title, quote=True)} en Vestua" '
        'loading="lazy" referrerpolicy="no-referrer">'
        '<span class="image-source">Imagen referencial · Vestua</span></a>'
        if image_url
        else '<div class="product-image-placeholder" aria-label="Imagen no disponible">'
        f'Referencia {escape(prenda.categoria)} · {escape(prenda.marca)} no disponible en Vestua</div>'
    )
    product_visual = (
        f'<div class="product-visual">{image_markup}'
        f'<span class="vestua-size">Talla Vestua: '
        f'<strong>{escape(product_size) if product_size else "No disponible"}</strong>'
        "</span></div>"
    )
    mold_origin = BRAND_MOLD_ORIGINS.get(prenda.marca)
    mold_origin_markup = (
        f'<div class="product-mold-origin">Molde {escape(mold_origin)}</div>'
        if mold_origin
        else ""
    )
    hidden = "" if es_primera else " hidden"
    return f"""<article class="product-card carousel-card" data-carousel-card
      aria-hidden="{'false' if es_primera else 'true'}"{hidden}>
      <div class="product-top">
        {product_visual}
        <div class="product-summary">
          <div class="product-brand">{escape(prenda.marca)} · {escape(prenda.linea)}</div>
          {mold_origin_markup}
          <div class="product-name">{escape(image_title)}</div>
          <div class="product-meta">{escape(prenda.categoria)} · Fit {escape(prenda.calce)} · {escape(prenda.tela)}<br>
            Elasticidad {prenda.elasticidad:g}% · Holgura diseño {prenda.holgura_diseno:g} cm · Origen {escape(prenda.origen)}</div>
        </div>
        <span class="recommend-badge verdict {escape(resultado.diagnostico.clase_css)}">{escape(badge)}</span>
      </div>
      <div class="fit-detail">
        <div class="fit-heading">
          <strong class="verdict {escape(resultado.diagnostico.clase_css)}">{escape(resultado.diagnostico.etiqueta)}</strong>
          <span>Referencia de medidas, no una talla</span>
        </div>
        <details class="fit-explanation">
          <summary>Ver por qué y comparar medidas</summary>
          <div class="explanation-content">
            <p>{escape(_fit_explanation(resultado, preferencia, prenda.elasticidad, prenda.tolerancia))}</p>
            <div class="measure-grid">{measures}</div>
            <div class="fit-foot">Tolerancia de la referencia: <b>±{prenda.tolerancia:g} cm</b></div>
            <p class="image-disclaimer">La ficha enlazada es una publicación de Vestua de la misma marca y categoría, no necesariamente la misma prenda de la matriz. La app compara cintura y cadera usando medidas de referencia; Vestua no publica medidas físicas específicas de esta ficha.</p>
          </div>
        </details>
      </div>
    </article>"""


def _render_store_recommendation(
    product: ProductoVestua,
    reference,
    result: ResultadoCalce,
    reference_label: str,
    index: int,
    preference: str,
    profile: PerfilMedidas,
) -> str:
    store = CATALOG_STORES_BY_URL.get(product.url, "Vestua")
    image_url = CATALOG_IMAGES_BY_URL.get(product.url, "")
    hidden = " hidden" if index else ""
    measures = "".join(_render_measure(measure) for measure in result.medidas)
    image = (
        f'<a class="product-image-link" href="{escape(product.url, quote=True)}" '
        f'target="_blank" rel="noopener noreferrer">'
        f'<img class="product-image" src="{escape(image_url, quote=True)}" '
        f'alt="Imagen de {escape(product.titulo, quote=True)} en {escape(store, quote=True)}" '
        'loading="lazy" referrerpolicy="no-referrer">'
        f'<span class="image-source">Ver prenda · {escape(store)}</span></a>'
        if image_url
        else '<div class="product-image-placeholder">Imagen no disponible</div>'
    )
    fit_description = _fit_explanation(
        result,
        preference,
        getattr(reference, "elasticidad", 0),
        getattr(reference, "tolerancia", 0),
    )
    return f"""<article class="product-card carousel-card store-recommendation-card"
      data-carousel-card aria-hidden="{'true' if index else 'false'}"{hidden}>
      <div class="product-top">
        <div class="product-visual">{image}
          <span class="vestua-size">Talla publicada: <strong>{escape(product.talla or "No indicada")}</strong></span>
        </div>
        <div class="product-summary">
          <div class="product-brand">{escape(store)} · {escape(product.marca or store)}</div>
          <div class="product-name">{escape(product.titulo)}</div>
          <div class="product-meta">{escape(product.tipo_prenda)} · {_format_price(product.precio_clp)}<br>
            Referencia estimada: {escape(reference_label)}</div>
          <a class="catalog-buy-link" href="{escape(product.url, quote=True)}"
            target="_blank" rel="noopener noreferrer">Ver prenda en {escape(store)}</a>
        </div>
        <span class="recommend-badge verdict {escape(result.diagnostico.clase_css)}">
          {escape(result.diagnostico.etiqueta)}</span>
      </div>
      <div class="fit-detail">
        <div class="fit-heading">
          <strong class="verdict {escape(result.diagnostico.clase_css)}">
            {escape(result.diagnostico.etiqueta)}</strong>
          <span>Estimación con medidas de referencia</span>
        </div>
        <details class="fit-explanation">
          <summary>Ver medidas comparadas</summary>
          <div class="explanation-content">
            <p>{escape(fit_description)}</p>
            <div class="measure-grid">{measures}</div>
            <p class="image-disclaimer">La tienda no publica medidas físicas específicas de esta prenda. La talla corresponde a la ficha enlazada; confirma la guía de tallas antes de comprar.</p>
          </div>
        </details>
      </div>
    </article>"""


def _store_listing_recommendations(
    profile: PerfilMedidas,
    preference: str,
    categories_allowed: Optional[Tuple[str, ...]] = None,
) -> str:
    if not any(value is not None for value in profile.como_diccionario().values()):
        return ""
    compatible = {
        "Podría quedarte bien",
        "Ajuste al límite",
        "Holgura al límite",
    }
    recommendations = []
    for product in CATALOG_PRODUCTS:
        if product.url not in WOMENSWEAR_STORES_BY_URL:
            continue
        if (
            categories_allowed is not None
            and product.categoria_referencia not in categories_allowed
        ):
            continue
        reference, reference_label = _reference_for_listing(product)
        if reference is None:
            continue
        if categories_allowed is not None and reference.categoria not in categories_allowed:
            continue
        result = _calculate_fit(reference, profile, preference)
        if (
            isfinite(result.puntuacion)
            and result.diagnostico.etiqueta in compatible
        ):
            recommendations.append(
                (product, reference, result, reference_label)
            )
    recommendations.sort(key=lambda item: (item[2].puntuacion, item[0].id))
    store_favorites = []
    for store in ("Paris", "Tricot"):
        favorite = next(
            (item for item in recommendations
             if WOMENSWEAR_STORES_BY_URL.get(item[0].url) == store),
            None,
        )
        if favorite:
            store_favorites.append(favorite)
    selected_ids = {item[0].id for item in store_favorites}
    recommendations = store_favorites + [
        item for item in recommendations if item[0].id not in selected_ids
    ][: 9 - len(store_favorites)]
    recommendations.sort(key=lambda item: (item[2].puntuacion, item[0].id))
    if not recommendations:
        return ""

    slides = "".join(
        _render_store_recommendation(
            product,
            reference,
            result,
            reference_label,
            index,
            preference,
            profile,
        )
        for index, (product, reference, result, reference_label)
        in enumerate(recommendations)
    )
    controls = (
        '<div class="carousel-controls" data-carousel-controls>'
        '<button class="carousel-arrow" type="button" data-previous '
        'aria-label="Ver prenda de tienda anterior" disabled>←</button>'
        '<span class="carousel-position" data-carousel-position '
        'aria-live="polite">Recomendado · 1 de '
        f'{len(recommendations)}</span>'
        '<button class="carousel-arrow" type="button" data-next '
        'aria-label="Ver siguiente prenda de tienda"'
        f'{" disabled" if len(recommendations) == 1 else ""}>→</button>'
        "</div>"
    )
    return (
        '<section class="alternative-recommendations store-listing-recommendations" '
        'id="store-listing-recommendations" aria-labelledby="store-listing-title">'
        '<div class="alternative-heading">'
        '<h2 id="store-listing-title">Prendas de tiendas que podrían quedarte bien</h2>'
        '<p class="sub">Productos disponibles en las tiendas del catálogo, '
        "ordenados por coincidencia con tus medidas. Las medidas de la prenda "
        "son referencias de calce, no datos publicados en la ficha.</p>"
        "</div>"
        '<div class="recommendation-carousel" data-carousel data-store-listing-carousel>'
        f'<div class="carousel-slides">{slides}</div>{controls}</div></section>'
    )


def _alternative_recommendations(
    perfil: PerfilMedidas,
    preferencia: str,
    productos_mostrados: tuple,
    categorias_permitidas: Optional[Tuple[str, ...]] = None,
) -> str:
    if not any(value is not None for value in perfil.como_diccionario().values()):
        return ""

    diagnosticos_compatibles = {
        "Podría quedarte bien",
        "Ajuste al límite",
        "Holgura al límite",
    }
    recomendaciones = sorted(
        (
            (prenda, CALCULATOR.calcular(prenda, perfil, preferencia))
            for prenda in CATALOG.prendas
            if prenda not in productos_mostrados
            and (
                categorias_permitidas is None
                or prenda.categoria in categorias_permitidas
            )
        ),
        key=lambda item: item[1].puntuacion,
    )
    recomendaciones = tuple(
        (prenda, resultado)
        for prenda, resultado in recomendaciones
        if resultado.diagnostico.etiqueta in diagnosticos_compatibles
    )
    if not recomendaciones:
        return ""

    slides = "".join(
        _render_product(prenda, resultado, indice, preferencia)
        for indice, (prenda, resultado) in enumerate(recomendaciones)
    )
    controls = (
        '<div class="carousel-controls" data-carousel-controls>'
        '<button class="carousel-arrow" type="button" data-previous '
        'aria-label="Ver opción compatible anterior" disabled>←</button>'
        '<span class="carousel-position" data-carousel-position '
        'aria-live="polite">Recomendado · 1 de '
        f'{len(recomendaciones)}</span>'
        '<button class="carousel-arrow" type="button" data-next '
        'aria-label="Ver opción compatible siguiente"'
        f'{" disabled" if len(recomendaciones) == 1 else ""}>→</button>'
        "</div>"
    )
    return (
        '<section class="alternative-recommendations" '
        'id="alternative-recommendations" aria-labelledby="alternative-title">'
        '<div class="alternative-heading">'
        '<h2 id="alternative-title">Otras opciones que podrían quedarte bien</h2>'
        '<p class="sub">Prendas con calce compatible o cercano, ordenadas por '
        "coincidencia. Se omiten las referencias del carrusel principal.</p>"
        "</div>"
        '<div class="recommendation-carousel" data-carousel data-alternative-carousel>'
        '<div class="carousel-tabs">'
        '<button class="carousel-tab active" type="button" data-recommended '
        'aria-pressed="true">★ Recomendado</button>'
        '<span class="carousel-hint">Usa las flechas para ver otras opciones</span>'
        "</div>"
        f'<div class="carousel-slides">{slides}</div>{controls}</div></section>'
    )


def _storefront_content() -> str:
    category_specs = (
        ("Blusas", "Blusa"),
        ("Jeans", "Jeans"),
        ("Vestidos", "Vestido"),
        ("Chaquetas", "Chaqueta"),
    )
    featured_types = ("Blazer", "Pantalón", "Vestido", "Blusa")
    storefront_types = {
        product_type for _, product_type in category_specs
    } | set(featured_types)
    products_by_type = {}
    for product in CATALOG_PRODUCTS:
        if product.tipo_prenda in storefront_types:
            products_by_type.setdefault(product.tipo_prenda, product)

    categories = "".join(
        f"""<a class="storefront-category" href="/?{urlencode({
            "view": "catalog", "type": product_type
        })}" aria-label="Explorar {escape(label, quote=True)}">
          <img src="{escape(CATALOG_IMAGES_BY_URL[product.url], quote=True)}"
            alt="" loading="lazy" referrerpolicy="no-referrer">
          <span class="storefront-category-copy">
            <span class="eyebrow">Descubre</span><strong>{escape(label)}</strong>
            <span>Ver prendas <span aria-hidden="true">→</span></span>
          </span>
        </a>"""
        for label, product_type in category_specs
        if (product := products_by_type.get(product_type)) is not None
    )
    featured = "".join(
        f"""<article class="storefront-product">
          <a class="storefront-product-image" href="{escape(product.url, quote=True)}"
            target="_blank" rel="noopener noreferrer">
            <img src="{escape(CATALOG_IMAGES_BY_URL[product.url], quote=True)}"
              alt="{escape(product.titulo, quote=True)}" loading="lazy"
              referrerpolicy="no-referrer">
          </a>
          <div class="storefront-product-info">
            <span>{escape(CATALOG_STORES_BY_URL.get(product.url, "Vestua"))}
              · {escape(product.marca or "Marca no indicada")}</span>
            <a href="{escape(product.url, quote=True)}" target="_blank"
              rel="noopener noreferrer">{escape(product.titulo)}</a>
            <strong>{_format_price(product.precio_clp)}</strong>
          </div>
        </article>"""
        for product_type in featured_types
        if (product := products_by_type.get(product_type)) is not None
    )
    hero_product = products_by_type.get("Vestido")
    hero_image = (
        f"""<a class="storefront-hero-visual"
          href="{escape(hero_product.url, quote=True)}" target="_blank"
          rel="noopener noreferrer" aria-label="Ver {escape(hero_product.titulo, quote=True)}">
          <img src="{escape(CATALOG_IMAGES_BY_URL[hero_product.url], quote=True)}"
            alt="" fetchpriority="high" referrerpolicy="no-referrer">
        </a>"""
        if hero_product
        else ""
    )
    promises = (
        ("Explora distintas tiendas", "Descubre prendas de Vestua, Paris y Tricot."),
        ("Encuentra tu estilo", "Navega por categorías y encuentra nuevas opciones."),
        ("Orientación de calce", "Compara referencias con tus medidas y preferencias."),
        ("Compra en origen", "Confirma disponibilidad directamente en la tienda."),
        ("Elige con confianza", "Usa la información como guía; tú decides qué te gusta."),
    )
    promise_items = "".join(
        f'<li><strong>{escape(title)}</strong><span>{escape(description)}</span></li>'
        for title, description in promises
    )
    return f"""<div class="storefront-page">
      <section class="storefront-hero" aria-labelledby="storefront-title">
        <div class="storefront-hero-copy">
          <span class="eyebrow">Calce · estilo personal</span>
          <h1 id="storefront-title">Tu estilo, tu calce, tu manera de elegir.</h1>
          <p>Explora prendas, descubre nuevos favoritos y encuentra referencias que te ayuden a elegir con más confianza.</p>
          <div class="storefront-hero-actions">
            <a class="matices-button matices-button-primary" href="/?view=catalog">Explorar prendas</a>
            <a class="matices-button" href="/?view=home">Tu Calce</a>
          </div>
        </div>
        {hero_image}
      </section>
      <section class="storefront-promise" aria-labelledby="storefront-promise-title">
        <h2 id="storefront-promise-title">Una experiencia para elegir a tu manera</h2>
        <ul>{promise_items}</ul>
      </section>
      <section class="storefront-section" aria-labelledby="storefront-categories-title">
        <div class="storefront-section-heading">
          <div><span class="eyebrow">Explora por estilo</span>
            <h2 id="storefront-categories-title">Encuentra tu próxima prenda</h2></div>
          <a href="/?view=catalog">Ver todo el catálogo <span aria-hidden="true">→</span></a>
        </div>
        <div class="storefront-categories">{categories}</div>
      </section>
      <section class="storefront-section" aria-labelledby="storefront-featured-title">
        <div class="storefront-section-heading">
          <div><span class="eyebrow">Selección Calce</span>
            <h2 id="storefront-featured-title">Productos destacados</h2></div>
          <a href="/?view=catalog">Descubrir más <span aria-hidden="true">→</span></a>
        </div>
        <div class="storefront-products">{featured}</div>
      </section>
      <section class="storefront-story" aria-labelledby="storefront-story-title">
        <img src="/assets/calce-isotipo.png" alt="" loading="lazy">
        <div><span class="eyebrow">Nuestra forma de verlo</span>
          <h2 id="storefront-story-title">La moda empieza por sentirte bien con lo que eliges.</h2>
          <p>Reunimos inspiración, prendas y orientación de calce en un solo lugar. Compara opciones con tus medidas y preferencias para tomar decisiones más informadas. Las recomendaciones son referenciales y no reemplazan las medidas verificadas de cada producto.</p>
          <a class="storefront-story-link" href="/?view=home">Conoce tu calce <span aria-hidden="true">→</span></a>
        </div>
      </section>
    </div>"""


def _fit_information_content() -> str:
    preference_labels = {
        "adjusted": "Ajustado",
        "regular": "Regular",
        "loose": "Holgado",
    }
    preference_rows = "".join(
        f"<tr><th scope=\"row\">{preference_labels[key]}</th>"
        f"<td>{minimum:g} a {maximum:g} cm</td><td>{target:g} cm</td></tr>"
        for key, (minimum, maximum, target) in PREFERENCIAS_CALCE.items()
    )
    size_rows = "".join(
        f"<tr><th scope=\"row\">{escape(talla.etiqueta)}</th>"
        f"<td>{escape(talla.europea or '—')}</td>"
        f"<td>{escape(talla.estadounidense or '—')}</td>"
        f"<td>{escape(talla.busto)}</td>"
        f"<td>{escape(talla.cintura)}</td>"
        f"<td>{escape(talla.cadera)}</td></tr>"
        for talla in STANDARD_SIZES
    )
    variables = "".join(
        f"""<article class="variable">
          <div class="variable-top"><strong>{escape(name)}</strong>
            <span class="impact {escape(impact.lower().replace(' ', '-'))}">{escape(impact)}</span></div>
          <span class="variable-category">{escape(category)}</span>
          <p>{escape(description)}</p>
        </article>"""
        for category, name, description, impact in sorted(
            VARIABLES,
            key=lambda variable: IMPACT_PRIORITY.get(
                variable[3], len(IMPACT_PRIORITY)
            ),
        )
    )
    return f"""<div class="fit-info-page">
      <div class="fit-info-hero">
        <span class="eyebrow">Calce · metodología</span>
        <h1 id="fit-info-title">Cómo comparamos las prendas</h1>
        <p>Conoce las medidas, rangos y criterios que usa Calce para ordenar las referencias. El resultado orienta tu elección y no garantiza el calce real.</p>
      </div>
      <section class="fit-info-overview" aria-label="Resumen del cálculo">
        <article><span>01</span><h2>Cintura y cadera</h2>
          <p>Son las medidas corporales que se comparan para calcular el ajuste. El busto se considera al estimar tallas.</p></article>
        <article><span>02</span><h2>Holgura</h2>
          <p>Se calcula restando la medida corporal a la medida de la prenda. Un valor positivo indica espacio; uno negativo, que la prenda mide menos.</p></article>
        <article><span>03</span><h2>Menor puntaje</h2>
          <p>Entre referencias comparables, un puntaje menor aparece primero. Con medidas incompletas, el diagnóstico es parcial.</p></article>
      </section>
      <section class="fit-info-panel" aria-labelledby="standard-size-table-title">
        <h2 id="standard-size-table-title">Tabla estándar de tallas</h2>
        <p>Rangos orientativos en centímetros. Las equivalencias pueden variar entre marcas.</p>
        <div class="table-scroll"><table class="fit-info-table standard-size-table">
          <thead><tr><th scope="col">Talla alfa</th><th scope="col">Talla EU</th>
            <th scope="col">Talla EE.UU.</th><th scope="col">Busto / pecho (cm)</th>
            <th scope="col">Cintura (cm)</th><th scope="col">Cadera (cm)</th></tr></thead>
          <tbody>{size_rows}</tbody>
        </table></div>
      </section>
      <section class="fit-info-panel">
        <h2>Rangos orientativos de holgura</h2>
        <div class="table-scroll"><table class="fit-info-table">
          <thead><tr><th>Preferencia</th><th>Rango esperado</th><th>Objetivo</th></tr></thead>
          <tbody>{preference_rows}</tbody>
        </table></div>
      </section>
      <section class="fit-info-panel">
        <h2>Qué forma el puntaje</h2>
        <p class="fit-info-formula">Puntaje = 2 × desviación media + 0,2 × distancia media al objetivo</p>
        <ul><li>La desviación mide los centímetros fuera del rango elegido; dentro del rango vale 0.</li>
          <li>La distancia al objetivo es la diferencia absoluta entre holgura y objetivo.</li>
          <li>Desde 8% de elasticidad, el mínimo de holgura efectivo no puede ser inferior a −1 cm.</li>
          <li>La tolerancia propia de cada referencia afecta el diagnóstico, no el puntaje.</li></ul>
        <h2>Cómo interpretar el diagnóstico</h2>
        <p>“Podría quedarte bien” indica que las medidas están dentro del rango. Los estados de límite consideran la tolerancia de la referencia; si falta cintura o cadera, la revisión será parcial.</p>
      </section>
      <section class="section">
        <details class="variable-details">
          <summary class="section-title variable-details-summary">
            <div class="eyebrow">Detrás de cada recomendación</div>
            <span class="variable-details-indicator" aria-hidden="true"></span>
          </summary>
          <div class="catalog-panel">
            <div class="variable-grid">{variables}</div>
          </div>
        </details>
      </section>
    </div>"""


def renderizar_pagina(query: Dict[str, str]) -> str:
    marca = query.get("brand", "Zara")
    categoria = query.get("category", "")
    grupo_categoria = query.get("category_group", "")
    wizard_step = query.get("wizard_step", "1")
    if wizard_step not in {"1", "2", "3"}:
        wizard_step = "1"
    if categoria not in CATALOG.categorias():
        categoria = ""
    if grupo_categoria not in CATEGORY_GROUPS:
        grupo_categoria = ""
    preferencia = query.get("preference", "regular")
    perfil = PerfilMedidas.desde_formulario(
        {
            "bust": query.get("bust"),
            "waist": query.get("waist"),
            "hip": query.get("hip"),
        }
    )
    requested_view = query.get("view")
    active_view = (
        requested_view
        if requested_view in {
            "storefront", "home", "catalog", "account", "try-on", "profile", "info"
        }
        else "home" if "wizard_step" in query else "storefront"
    )
    categorias_permitidas = (
        CATALOG.categorias()
        if not grupo_categoria and not categoria
        else CATEGORY_GROUPS.get(
            grupo_categoria,
            (categoria,) if categoria else CATALOG.categorias(),
        )
    )
    prendas = tuple(
        prenda
        for prenda in CATALOG.filtrar(
            marca=marca if marca in CATALOG.marcas() else ""
        )
        if categorias_permitidas is None or prenda.categoria in categorias_permitidas
    )
    hay_filtro = (
        ("brand" in query and marca in CATALOG.marcas())
        or (
            "category" in query
            and categoria in CATALOG.categorias())
        or ("category_group" in query and grupo_categoria in CATEGORY_GROUPS)
    )
    hay_medida = any(
        valor is not None for valor in perfil.como_diccionario().values()
    )
    puede_recomendar = hay_medida or hay_filtro
    recomendaciones = sorted(
        (
            (prenda, CALCULATOR.calcular(prenda, perfil, preferencia))
            for prenda in prendas
        ),
        key=lambda elemento: elemento[1].puntuacion,
    )
    catalog_query = {"view": "catalog", "preference": preferencia}
    for measurement in ("bust", "waist", "hip"):
        if query.get(measurement):
            catalog_query[measurement] = query[measurement]
    catalog_url = f"/?{urlencode(catalog_query)}"
    storefront_tab_query = dict(query)
    storefront_tab_query["view"] = "storefront"
    storefront_tab_url = "/?" + urlencode(storefront_tab_query)
    home_tab_query = dict(query)
    home_tab_query["view"] = "home"
    home_tab_url = "/?" + urlencode(home_tab_query)
    catalog_tab_query = dict(query)
    catalog_tab_query["view"] = "catalog"
    catalog_tab_query.setdefault("preference", preferencia)
    catalog_tab_url = f"/?{urlencode(catalog_tab_query)}"
    try_on_tab_query = dict(query)
    try_on_tab_query["view"] = "try-on"
    try_on_tab_url = f"/?{urlencode(try_on_tab_query)}"
    info_tab_query = dict(query)
    info_tab_query["view"] = "info"
    info_tab_url = "/?" + urlencode(info_tab_query)
    auth_base_query = {
        "view": "account",
        "wizard_step": "2",
        "return_view": "storefront",
    }
    auth_base_query["auth_mode"] = "sign-in"
    sign_in_url = f"/?{urlencode(auth_base_query)}"
    auth_base_query["auth_mode"] = "sign-up"
    sign_up_url = f"/?{urlencode(auth_base_query)}"
    garment_catalog = _garment_catalog(
        perfil, preferencia, visible=True, query=query
    )
    virtual_try_on_panel = _virtual_try_on_panel()
    personal_recommendations = _personal_recommendations(
        perfil,
        preferencia,
        catalog_url,
    )
    alternative_recommendations = _alternative_recommendations(
        perfil,
        preferencia,
        prendas,
        CATEGORY_GROUPS.get(grupo_categoria),
    )
    store_recommendations = _store_listing_recommendations(
        perfil,
        preferencia,
        CATEGORY_GROUPS.get(grupo_categoria)
        or ((categoria,) if categoria else None),
    )
    storefront_content = _storefront_content()
    fit_information_content = _fit_information_content()
    results_heading = (
        '<div class="results-head">'
        '<div><h2>Tus mejores opciones</h2>'
        '<p class="sub">Holgura positiva = la prenda mide más que tu cuerpo.</p></div>'
        f'<span class="count">{len(prendas)} '
        f'{"referencia" if len(prendas) == 1 else "referencias"}</span>'
        '</div>'
        if hay_filtro
        else ""
    )
    if not puede_recomendar:
        results_panel_content = ""
    elif recomendaciones:
        slides = "".join(
            _render_product(prenda, resultado, indice, preferencia)
            for indice, (prenda, resultado) in enumerate(recomendaciones)
        )
        controls = (
            '<div class="carousel-controls" data-carousel-controls>'
            '<button class="carousel-arrow" type="button" data-previous '
            'aria-label="Ver recomendación anterior" disabled>←</button>'
            '<span class="carousel-position" data-carousel-position '
            'aria-live="polite">Recomendado · 1 de '
            f'{len(recomendaciones)}</span>'
            '<button class="carousel-arrow" type="button" data-next '
            'aria-label="Ver recomendación siguiente"'
            f'{" disabled" if len(recomendaciones) == 1 else ""}>→</button>'
            "</div>"
        )
        html_resultados = (
            '<div class="recommendation-carousel" data-carousel>'
            '<div class="carousel-tabs">'
            '<button class="carousel-tab active" type="button" data-recommended '
            'aria-pressed="true">★ Recomendado</button>'
            '<span class="carousel-hint">Usa las flechas para ver otras opciones</span>'
            "</div>"
            f'<div class="carousel-slides">{slides}</div>{controls}</div>'
        )
        results_panel_content = (
            '<div class="results-content" aria-live="polite">'
            f"{personal_recommendations}{results_heading}{html_resultados}</div>"
        )
    else:
        html_resultados = (
            '<div class="empty">No encontramos referencias con esos filtros. '
            "Prueba con otra marca o tipo de prenda.</div>"
        )
        results_panel_content = (
            '<div class="results-content" aria-live="polite">'
            f"{personal_recommendations}{results_heading}{html_resultados}</div>"
        )
    template = (WEB_DIRECTORY / "index.html").read_text(encoding="utf-8")
    return template.format(
        supabase_url=escape(SUPABASE_URL, quote=True),
        supabase_publishable_key=escape(SUPABASE_PUBLISHABLE_KEY, quote=True),
        startup_dialogs=(
            ""
            if active_view != "home"
            else (
                '<dialog class="welcome-dialog" data-startup-dialog '
                'aria-labelledby="welcome-title">'
                '<div class="welcome-window">'
                '<span class="welcome-eyebrow">Tu guía de calce personal</span>'
                '<h1 id="welcome-title">Encuentra prendas que podrían quedarte bien.</h1>'
                '</div></dialog>'
                '<dialog class="welcome-dialog welcome-dialog--second" '
                'data-startup-dialog aria-labelledby="preferences-title">'
                '<div class="welcome-window">'
                '<p class="welcome-message" id="preferences-title">'
                'Tu cuerpo, tus preferencias.</p></div></dialog>'
            )
        ),
        measurement_fields=_measurement_fields(query),
        wizard_step=wizard_step,
        results_panel_content=results_panel_content,
        wizard_page_results_hidden=(
            " hidden" if active_view != "home" or wizard_step != "3" else ""
        ),
        alternative_recommendations=alternative_recommendations,
        store_recommendations=store_recommendations,
        garment_catalog=garment_catalog,
        storefront_content=storefront_content,
        fit_information_content=fit_information_content,
        size_ranges=_size_ranges(),
        virtual_try_on_panel=virtual_try_on_panel,
        storefront_url=escape(storefront_tab_url, quote=True),
        home_tab_url=escape(home_tab_url, quote=True),
        catalog_tab_url=escape(catalog_tab_url, quote=True),
        try_on_tab_url=escape(try_on_tab_url, quote=True),
        info_tab_url=escape(info_tab_url, quote=True),
        sign_in_url=escape(sign_in_url, quote=True),
        sign_up_url=escape(sign_up_url, quote=True),
        storefront_link_current=(
            ' aria-current="page"' if active_view == "storefront" else ""
        ),
        home_link_current=' aria-current="page"' if active_view == "home" else "",
        catalog_link_current=' aria-current="page"' if active_view == "catalog" else "",
        try_on_link_current=' aria-current="page"' if active_view == "try-on" else "",
        info_link_current=' aria-current="page"' if active_view == "info" else "",
        sign_in_link_current=(
            ' aria-current="page"'
            if active_view == "account" and query.get("auth_mode") != "sign-up"
            else ""
        ),
        sign_up_link_current=(
            ' aria-current="page"'
            if active_view == "account" and query.get("auth_mode") == "sign-up"
            else ""
        ),
        home_panel_hidden=(
            ' hidden' if active_view not in {"home", "account"} else ""
        ),
        storefront_panel_hidden=(
            ' hidden' if active_view != "storefront" else ""
        ),
        info_panel_hidden=' hidden' if active_view != "info" else "",
        catalog_panel_hidden=' hidden' if active_view != "catalog" else "",
        try_on_panel_hidden=' hidden' if active_view != "try-on" else "",
        profile_panel_hidden=' hidden' if active_view != "profile" else "",
    )


class MedidasRequestHandler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/healthz":
            self._send_content("ok", "text/plain; charset=utf-8")
            return
        if parsed.path == "/api/vton-products":
            query = parse_qs(parsed.query, keep_blank_values=True)
            self._send_json(
                _virtual_try_on_products(
                    query.get("search", [""])[-1],
                    tuple(query.get("product_url", [])[:24]),
                )
            )
            return
        if parsed.path == "/api/catalog":
            query = {
                key: values[-1]
                for key, values in parse_qs(
                    parsed.query, keep_blank_values=True
                ).items()
            }
            data = _catalog_page_data(query)
            self._send_content(
                json.dumps(data, ensure_ascii=False),
                "application/json; charset=utf-8",
            )
            return
        if parsed.path == "/":
            query = {
                key: values[-1]
                for key, values in parse_qs(
                    parsed.query, keep_blank_values=True
                ).items()
            }
            self._send_content(renderizar_pagina(query), "text/html; charset=utf-8")
            return
        if parsed.path == "/styles.css":
            self._send_static_file(WEB_DIRECTORY / "styles.css", "text/css; charset=utf-8")
            return
        if parsed.path == "/app.js":
            self._send_static_file(
                WEB_DIRECTORY / "app.js", "text/javascript; charset=utf-8"
            )
            return
        if parsed.path.startswith("/assets/"):
            asset = (WEB_DIRECTORY / parsed.path.lstrip("/")).resolve()
            if WEB_DIRECTORY.resolve() not in asset.parents:
                self.send_error(404, "Recurso no encontrado")
                return
            content_type = guess_type(str(asset))[0] or "application/octet-stream"
            self._send_static_file(asset, content_type)
            return
        self.send_error(404, "Página no encontrada")

    def do_POST(self) -> None:
        if urlparse(self.path).path != "/api/try-on":
            self.send_error(404, "Página no encontrada")
            return
        self._post_virtual_try_on()

    def _post_virtual_try_on(self) -> None:
        authorization = self.headers.get("Authorization", "")
        scheme, separator, access_token = authorization.partition(" ")
        if (
            scheme.casefold() != "bearer"
            or not separator
            or not access_token
            or len(access_token) > 8192
        ):
            self._send_json(
                {"error": "Inicia sesión para usar el Probador."}, 401
            )
            return
        if not SUPABASE_URL or not SUPABASE_PUBLISHABLE_KEY:
            self._send_json(
                {"error": "La verificación de sesión no está configurada."},
                503,
            )
            return
        try:
            user = _supabase_user_for_token(access_token)
        except HTTPError as error:
            status = 401 if error.code in {401, 403} else 502
            message = (
                "Tu sesión de Supabase no es válida."
                if status == 401
                else "No se pudo verificar la sesión de Supabase."
            )
            self._send_json({"error": message}, status)
            return
        except (
            URLError,
            TimeoutError,
            OSError,
            IncompleteRead,
            UnicodeDecodeError,
            json.JSONDecodeError,
        ) as error:
            self.log_error(
                "Supabase session verification failed (%s)",
                type(error).__name__,
            )
            self._send_json(
                {"error": "No se pudo verificar la sesión de Supabase."}, 502
            )
            return
        if not isinstance(user, dict) or not isinstance(user.get("id"), str):
            self._send_json(
                {"error": "Tu sesión de Supabase no es válida."}, 401
            )
            return

        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self._send_json(
                {"error": "La solicitud no tiene un tamaño válido."}, 400
            )
            return
        if content_length <= 0:
            self._send_json({"error": "La solicitud está vacía."}, 400)
            return
        if content_length > MAX_VTON_REQUEST_BYTES:
            self._send_json(
                {"error": "La solicitud supera el límite permitido."}, 413
            )
            return

        try:
            payload = json.loads(
                self.rfile.read(content_length).decode("utf-8")
            )
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._send_json(
                {"error": "El cuerpo de la solicitud no es JSON válido."}, 400
            )
            return
        if not isinstance(payload, dict):
            self._send_json(
                {"error": "La solicitud no tiene el formato esperado."}, 400
            )
            return

        provider = payload.get("provider", "automatic")
        if provider not in (
            "automatic",
            "rapidapi",
            "datatobiz",
            "diffusion",
            "refiner",
        ):
            self._send_json(
                {"error": "Selecciona un proveedor de prueba válido."}, 400
            )
            return
        gender = payload.get("gender", "woman")
        if provider == "refiner" and gender not in ("woman", "man"):
            self._send_json(
                {"error": "Selecciona un género válido para Clothes Refiner."},
                400,
            )
            return
        person_image_base64 = payload.get("person_image_base64")
        product_urls = payload.get("product_urls")
        if product_urls is None:
            legacy_product_url = payload.get("product_url")
            product_urls = (
                [legacy_product_url]
                if isinstance(legacy_product_url, str)
                else None
            )
        if (
            not isinstance(person_image_base64, str)
            or not isinstance(product_urls, list)
            or not 1 <= len(product_urls) <= 2
            or any(not isinstance(product_url, str) for product_url in product_urls)
            or len(set(product_urls)) != len(product_urls)
        ):
            self._send_json(
                {"error": "Se requieren la foto y una o dos prendas distintas."},
                400,
            )
            return
        try:
            person_image = base64.b64decode(
                person_image_base64, validate=True
            )
        except (binascii.Error, ValueError):
            self._send_json(
                {"error": "La foto de Inicio no contiene Base64 válido."}, 400
            )
            return
        if not person_image:
            self._send_json(
                {"error": "Selecciona una foto en Inicio."}, 400
            )
            return
        if len(person_image) > MAX_VTON_IMAGE_BYTES:
            self._send_json(
                {"error": "La foto supera el límite de 5 MB."}, 413
            )
            return
        try:
            person_image = _prepare_rapidapi_image(
                person_image,
                "La foto de Inicio",
            )
        except ValueError as error:
            self._send_json({"error": str(error)}, 400)
            return

        products = []
        for product_url in product_urls:
            product = CATALOG_PRODUCTS_BY_URL.get(product_url)
            if product is None:
                self._send_json(
                    {"error": "Una prenda seleccionada no está en el catálogo."},
                    404,
                )
                return
            products.append(product)
        selected_products = tuple(products)
        categories = tuple(
            _virtual_try_on_category(product)
            for product in selected_products
        )
        supported_single_categories = {"upper_body", "lower_body", "dresses"}
        if (
            len(selected_products) == 1
            and categories[0] not in supported_single_categories
        ):
            self._send_json(
                {"error": "El Probador solo admite prendas superiores, inferiores o vestidos."},
                400,
            )
            return
        if len(selected_products) == 2 and set(categories) != {
            "upper_body",
            "lower_body",
        }:
            self._send_json(
                {"error": "Para combinar prendas, selecciona una superior y una inferior."},
                400,
            )
            return
        if provider == "datatobiz" and not _supports_datatobiz_fallback(
            selected_products
        ):
            self._send_json(
                {"error": "DataToBiz solo admite una prenda superior individual."},
                400,
            )
            return
        if provider == "rapidapi" and not RAPIDAPI_KEY:
            self._send_json(
                {"error": "Configura RAPIDAPI_KEY para usar Try on Clothes Pro."},
                503,
            )
            return
        if provider == "datatobiz" and not DATATOBIZ_RAPIDAPI_KEY:
            self._send_json(
                {
                    "error": (
                        "Configura DATATOBIZ_RAPIDAPI_KEY para usar "
                        "DataToBiz de forma independiente."
                    )
                },
                503,
            )
            return
        if provider == "diffusion" and len(selected_products) != 1:
            self._send_json(
                {"error": "Try-On Diffusion admite una sola prenda por solicitud."},
                400,
            )
            return
        if provider == "diffusion" and not RAPIDAPI_DIFFUSION_KEY:
            self._send_json(
                {"error": "Configura una clave RapidAPI para Try-On Diffusion."},
                503,
            )
            return
        if provider == "refiner" and (
            not RAPIDAPI_KEY or not RAPIDAPI_REFINER_KEY
        ):
            self._send_json(
                {
                    "error": (
                        "Try on Clothes Refiner requiere RAPIDAPI_KEY para "
                        "generar la imagen preliminar y RAPIDAPI_REFINER_KEY "
                        "para refinarla."
                    )
                },
                503,
            )
            return
        if (
            provider == "automatic"
            and not RAPIDAPI_KEY
            and not DATATOBIZ_RAPIDAPI_KEY
        ):
            self._send_json(
                {
                    "error": (
                        "Configura RAPIDAPI_KEY o DATATOBIZ_RAPIDAPI_KEY "
                        "en el servidor."
                    )
                },
                503,
            )
            return
        if (
            provider == "automatic"
            and not RAPIDAPI_KEY
            and DATATOBIZ_RAPIDAPI_KEY
            and not _supports_datatobiz_fallback(selected_products)
        ):
            self._send_json(
                {
                    "error": (
                        "DataToBiz solo admite una prenda superior individual. "
                        "Configura RAPIDAPI_KEY para probar prendas inferiores "
                        "o combinaciones."
                    )
                },
                503,
            )
            return

        if provider == "automatic":
            fallback_limit = (
                ""
                if _supports_datatobiz_fallback(selected_products)
                else (
                    " DataToBiz solo puede respaldar una prenda superior "
                    "individual; no admite prendas inferiores, vestidos ni "
                    "combinaciones."
                )
            )
        elif provider == "rapidapi":
            fallback_limit = (
                " Modo directo seleccionado; no se intenta DataToBiz."
            )
        elif provider == "diffusion":
            fallback_limit = (
                " Modo directo seleccionado; no se intenta otra API."
            )
        elif provider == "refiner":
            fallback_limit = (
                " Refiner usa Try on Clothes Pro para generar la imagen "
                "preliminar antes de refinarla."
            )
        else:
            fallback_limit = ""
        try:
            if provider == "datatobiz":
                result = _datatobiz_try_on(person_image, selected_products[0])
                result["detail"] = "Resultado Probador (DataToBiz)"
            elif provider == "rapidapi":
                result = _rapidapi_try_on(person_image, selected_products)
                result["detail"] = "Resultado Probador (Try on Clothes Pro)"
            elif provider == "diffusion":
                result = _try_on_diffusion(person_image, selected_products[0])
                result["detail"] = "Resultado Probador (Try-On Diffusion)"
            elif provider == "refiner":
                garment_files = _prepare_rapidapi_garment_files(
                    person_image,
                    selected_products,
                )
                coarse_result = _rapidapi_try_on_with_garments(
                    person_image,
                    garment_files,
                )
                coarse_image_url = coarse_result.get("result_image_url")
                if not coarse_image_url:
                    raise ValueError(
                        "Try on Clothes Pro no devolvió la imagen preliminar "
                        "requerida por Refiner."
                    )
                result = _try_on_clothes_refiner_with_garments(
                    person_image,
                    coarse_image_url,
                    gender,
                    garment_files,
                )
                result["detail"] = "Resultado Probador (Try on Clothes Refiner)"
            else:
                result = _try_on_with_fallback(person_image, selected_products)
        except TryOnProvidersError as error:
            def describe_provider_error(provider_error: Exception) -> str:
                if isinstance(provider_error, HTTPError):
                    detail = _rapidapi_http_error_detail(provider_error)
                    return (
                        f"HTTP {provider_error.code}: {detail}"
                        if detail
                        else f"HTTP {provider_error.code}"
                    )
                if isinstance(provider_error, ValueError):
                    return str(provider_error)[:200]
                return type(provider_error).__name__

            self._send_json(
                {
                    "error": (
                        "Fallaron Try on Clothes Pro y DataToBiz. "
                        f"Principal: {describe_provider_error(error.primary_error)}. "
                        f"Alternativa: {describe_provider_error(error.fallback_error)}."
                    )
                },
                502,
            )
            return
        except HTTPError as error:
            if error.code == 429:
                provider_name = (
                    {
                        "datatobiz": "DataToBiz",
                        "diffusion": "Try-On Diffusion",
                        "refiner": "Try on Clothes Refiner",
                    }.get(provider, "Try on Clothes Pro")
                )
                message = (
                    f"{provider_name} rechazó temporalmente la solicitud "
                    "(HTTP 429). "
                    "Puede ser un límite por minuto/segundo o del proveedor, "
                    "aunque la cuota mensual no esté agotada."
                )
                message += fallback_limit
                detail = _rapidapi_http_error_detail(error)
                if detail:
                    message += f" Detalle: {detail}"
                retry_after = (
                    error.headers.get("Retry-After")
                    if error.headers
                    else None
                )
                if retry_after:
                    message += f" Reintenta después de: {retry_after}."
                self._send_json(
                    {"error": message},
                    429,
                )
                return
            provider_name = (
                {
                    "datatobiz": "DataToBiz",
                    "diffusion": "Try-On Diffusion",
                    "refiner": "Try on Clothes Refiner",
                }.get(provider, "Try on Clothes Pro")
            )
            detail = _rapidapi_http_error_detail(error)
            self._send_json(
                {
                    "error": (
                        f"{provider_name} rechazó la solicitud "
                        f"(HTTP {error.code})."
                        f"{f' Detalle: {detail}' if detail else ''}"
                        f"{fallback_limit}"
                    )
                },
                502,
            )
            return
        except (URLError, TimeoutError, OSError, IncompleteRead) as error:
            self.log_error(
                "RapidAPI try-on request failed (%s)",
                type(error).__name__,
            )
            provider_name = (
                {
                    "datatobiz": "DataToBiz",
                    "diffusion": "Try-On Diffusion",
                    "refiner": "Try on Clothes Refiner",
                }.get(provider, "Try on Clothes Pro")
            )
            self._send_json(
                {
                    "error": (
                        "No se pudo descargar las imágenes o completar la "
                        f"solicitud con {provider_name}.{fallback_limit}"
                    )
                },
                502,
            )
            return
        except ValueError as error:
            self._send_json(
                {"error": f"{error}{fallback_limit}"},
                502,
            )
            return
        self._send_json(
            {
                "status": "success",
                "detail": "Resultado Probador",
                **result,
            }
        )

    def _send_static_file(self, path: Path, content_type: str) -> None:
        try:
            content = path.read_bytes()
        except FileNotFoundError:
            self.send_error(404, "Recurso no encontrado")
            return
        except OSError as error:
            self.send_error(500, f"No se pudo leer el recurso: {error}")
            return
        self._send_content(
            content,
            content_type,
            cache_control="public, max-age=3600",
        )

    def _send_json(self, payload: Dict[str, object], status: int = 200) -> None:
        self._send_content(
            json.dumps(payload, ensure_ascii=False),
            "application/json; charset=utf-8",
            status=status,
        )

    def _send_content(
        self,
        content,
        content_type: str,
        cache_control: Optional[str] = None,
        status: int = 200,
    ) -> None:
        if isinstance(content, str):
            content = content.encode("utf-8")
        encoding_quality = {}
        for encoding in self.headers.get("Accept-Encoding", "").split(","):
            name, *parameters = encoding.strip().lower().split(";")
            if not name:
                continue
            quality = next(
                (
                    parameter.strip()[2:]
                    for parameter in parameters
                    if parameter.strip().startswith("q=")
                ),
                "1",
            )
            try:
                encoding_quality[name] = float(quality)
            except ValueError:
                encoding_quality[name] = 0
        accepts_gzip = encoding_quality.get(
            "gzip", encoding_quality.get("*", 0)
        ) > 0
        compressed = False
        if accepts_gzip and len(content) >= 1024:
            compressed_content = gzip.compress(content, compresslevel=5, mtime=0)
            if len(compressed_content) < len(content):
                content = compressed_content
                compressed = True
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Vary", "Accept-Encoding")
        if cache_control:
            self.send_header("Cache-Control", cache_control)
        if compressed:
            self.send_header("Content-Encoding", "gzip")
        self.end_headers()
        self.wfile.write(content)

    def log_message(self, format: str, *args) -> None:
        print(f"{self.address_string()} - {format % args}")


def iniciar_servidor(
    host: Optional[str] = None,
    port: Optional[int] = None,
) -> None:
    host = host or os.environ.get("HOST", "0.0.0.0" if IS_RENDER else HOST)
    port = port or int(os.environ.get("PORT", str(PORT)))
    servidor = ThreadingHTTPServer((host, port), MedidasRequestHandler)
    url = f"http://{host}:{port}/"
    print(f"Medidas está disponible en {url}")
    if not IS_RENDER:
        try:
            _abrir_navegador(url)
        except (OSError, subprocess.CalledProcessError, webbrowser.Error) as error:
            print(f"No se pudo abrir Chrome automáticamente: {error}")
            print(f"Abre esta dirección manualmente: {url}")
    try:
        servidor.serve_forever()
    except KeyboardInterrupt:
        print("\nServidor detenido.")
    finally:
        servidor.server_close()


def _abrir_navegador(url: str) -> None:
    if sys.platform == "darwin":
        subprocess.run(
            ["open", "-a", "Google Chrome", url],
            check=True,
            capture_output=True,
            text=True,
        )
        return

    if not webbrowser.open(url):
        raise webbrowser.Error("No se encontró un navegador disponible.")


if __name__ == "__main__":
    iniciar_servidor()

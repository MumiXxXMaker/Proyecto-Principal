import base64
from io import BytesIO
import json
import threading
import unittest
from http.server import ThreadingHTTPServer
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import Request, urlopen
from unittest.mock import patch

from PIL import Image

from web.servidor import (
    CATALOG_IMAGES_BY_URL,
    CATALOG_PRODUCTS,
    MedidasRequestHandler,
    _upper_body_reference_image,
    _virtual_try_on_category,
    _virtual_try_on_panel,
    _datatobiz_response_source,
    _supports_datatobiz_fallback,
    renderizar_pagina,
)


class _FakeResponse:
    def __init__(self, body, headers=None):
        self.body = body
        self.headers = headers or {}

    def read(self, limit=-1):
        return self.body if limit < 0 else self.body[:limit]

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False


def _jpeg_fixture(width=300, height=300):
    output = BytesIO()
    Image.new("RGB", (width, height), "white").save(output, format="JPEG")
    return output.getvalue()


class DeploymentTests(unittest.TestCase):
    def start_server(self):
        server = ThreadingHTTPServer(("127.0.0.1", 0), MedidasRequestHandler)
        worker = threading.Thread(target=server.serve_forever)
        worker.start()
        self.addCleanup(server.server_close)
        self.addCleanup(worker.join)
        self.addCleanup(server.shutdown)
        return server

    def test_health_check_returns_ok(self):
        server = self.start_server()

        with urlopen(f"http://127.0.0.1:{server.server_port}/healthz") as response:
            self.assertEqual(response.status, 200)
            self.assertEqual(response.read(), b"ok")

    def test_virtual_try_on_product_search_returns_catalog_matches(self):
        server = self.start_server()
        product = CATALOG_PRODUCTS[0]
        url = (
            f"http://127.0.0.1:{server.server_port}/api/vton-products"
            f"?search={quote(product.titulo)}"
        )

        with urlopen(url) as response:
            data = json.loads(response.read())

        self.assertTrue(
            any(item["product_url"] == product.url for item in data["products"])
        )

    def test_virtual_try_on_categories_follow_catalog_product_types(self):
        categories = {
            product.tipo_prenda: _virtual_try_on_category(product)
            for product in CATALOG_PRODUCTS
        }
        upper_types = (
            "Accesorio", "Bata", "Blazer", "Blusa", "Body", "Camisa",
            "Camisola", "Cardigan", "Chaleco", "Chaqueta", "Corset",
            "Enterito", "Kimono", "Parka", "Peto", "Pijama", "Polera",
            "Polerón", "Sweater", "Top",
        )
        lower_types = (
            "Buzo", "Calza", "Falda", "Jeans", "Pantalón", "Shorts",
        )

        for product_type in upper_types:
            self.assertEqual(categories[product_type], "upper_body")
        for product_type in lower_types:
            self.assertEqual(categories[product_type], "lower_body")
        self.assertEqual(categories["Vestido"], "dresses")
        for product_type in ("Ropa interior", "Ropa de playa", "Ropa"):
            self.assertEqual(categories[product_type], "excluded")

    def test_datatobiz_fallback_only_accepts_one_upper_garment(self):
        upper_product = next(
            product
            for product in CATALOG_PRODUCTS
            if _virtual_try_on_category(product) == "upper_body"
        )
        lower_product = next(
            product
            for product in CATALOG_PRODUCTS
            if _virtual_try_on_category(product) == "lower_body"
        )

        self.assertTrue(_supports_datatobiz_fallback((upper_product,)))
        self.assertFalse(_supports_datatobiz_fallback((lower_product,)))
        self.assertFalse(
            _supports_datatobiz_fallback((upper_product, lower_product))
        )

    def test_datatobiz_binary_image_response_becomes_data_url(self):
        image_source = _datatobiz_response_source(
            _FakeResponse(
                _jpeg_fixture(),
                {"Content-Type": "image/jpeg"},
            )
        )

        self.assertEqual(image_source[0], "result_image_data_url")
        self.assertTrue(image_source[1].startswith("data:image/jpeg;base64,"))

    def test_catalog_type_filter_groups_and_omits_excluded_types(self):
        page = renderizar_pagina({"view": "catalog"})
        type_filter_start = page.index(
            '<label>Tipo de prenda<select data-catalog-type-filter>'
        )
        type_filter_end = page.index("</select>", type_filter_start)
        type_filter = page[type_filter_start:type_filter_end]

        self.assertIn('<optgroup label="Prendas superiores">', type_filter)
        self.assertIn('<optgroup label="Prendas inferiores">', type_filter)
        self.assertIn('<optgroup label="Vestidos">', type_filter)
        for excluded_type in ("Ropa interior", "Ropa de playa", "Ropa"):
            self.assertNotIn(f">{excluded_type}</option>", type_filter)

    def test_virtual_try_on_resolves_saved_products_by_url(self):
        server = self.start_server()
        product = next(
            product
            for product in CATALOG_PRODUCTS
            if _virtual_try_on_category(product) == "lower_body"
            and CATALOG_IMAGES_BY_URL.get(product.url)
        )
        url = (
            f"http://127.0.0.1:{server.server_port}/api/vton-products"
            f"?product_url={quote(product.url, safe='')}"
        )

        with urlopen(url) as response:
            data = json.loads(response.read())

        self.assertEqual(len(data["products"]), 1)
        self.assertEqual(data["products"][0]["product_url"], product.url)
        self.assertEqual(data["products"][0]["category"], "lower_body")

    def test_virtual_try_on_places_garments_beside_photo_and_selector_below(self):
        panel = _virtual_try_on_panel()

        self.assertLess(
            panel.index("data-vton-person-preview"),
            panel.index("data-vton-output"),
        )
        self.assertLess(
            panel.index("data-vton-output"),
            panel.index("data-vton-product-list"),
        )
        self.assertNotIn("Prendas a probar", panel)
        self.assertNotIn("data-vton-garment-list", panel)
        self.assertIn('data-vton-product-group="upper_body"', panel)
        self.assertIn('data-vton-product-group="lower_body"', panel)
        self.assertIn('data-vton-garment-tooltip role="tooltip"', panel)
        self.assertIn("data-vton-product-select multiple", panel)
        self.assertIn("superior y una inferior", panel)
        self.assertNotIn("data-vton-product-search", panel)
        self.assertNotIn("recorte de la parte superior de tu foto", panel)
        self.assertNotIn("se comparten con RapidAPI", panel)
        self.assertNotIn("Blusa Básica Pabilo", panel)
        self.assertLess(
            panel.index("data-vton-output"),
            panel.index("data-vton-result"),
        )
        self.assertLess(
            panel.index("data-vton-result"),
            panel.index("data-vton-product-list"),
        )

    def test_upper_body_reference_is_cropped_from_person_photo(self):
        crop = _upper_body_reference_image(_jpeg_fixture(300, 400))

        with Image.open(BytesIO(crop)) as image:
            self.assertEqual(image.size, (210, 192))

    def test_virtual_try_on_rejects_anonymous_requests(self):
        server = self.start_server()
        request = Request(
            f"http://127.0.0.1:{server.server_port}/api/try-on",
            data=b"{}",
            headers={"Content-Type": "application/json"},
            method="POST",
        )

        with self.assertRaises(HTTPError) as error:
            urlopen(request)

        self.assertEqual(error.exception.code, 401)

    def test_virtual_try_on_sends_person_and_top_images_to_rapidapi(self):
        server = self.start_server()
        product = next(
            product
            for product in CATALOG_PRODUCTS
            if _virtual_try_on_category(product) == "upper_body"
            and CATALOG_IMAGES_BY_URL.get(product.url)
        )
        person_image = _jpeg_fixture()
        result_image_url = "https://images.example/result.jpg"
        request = Request(
            f"http://127.0.0.1:{server.server_port}/api/try-on",
            data=json.dumps(
                {
                    "person_image_base64": base64.b64encode(
                        person_image
                    ).decode("ascii"),
                    "product_url": product.url,
                }
            ).encode("utf-8"),
            headers={
                "Authorization": "Bearer supabase-access-token",
                "Content-Type": "application/json",
            },
            method="POST",
        )

        with patch("web.servidor.SUPABASE_URL", "https://supabase.example"), \
                patch("web.servidor.SUPABASE_PUBLISHABLE_KEY", "publishable-key"), \
                patch("web.servidor.RAPIDAPI_KEY", "rapidapi-secret"), \
                patch(
                    "web.servidor.urlopen",
                    side_effect=[
                        _FakeResponse(b'{"id":"user-123"}'),
                        _FakeResponse(person_image),
                        _FakeResponse(b'{"error_code":0,"task_id":"task-123"}'),
                        _FakeResponse(
                            b'{"error_code":0,"task_status":1}'
                        ),
                        _FakeResponse(
                            json.dumps(
                                {
                                    "error_code": 0,
                                    "task_status": 2,
                                    "output": {"image_url": result_image_url},
                                }
                            ).encode("utf-8")
                        ),
                    ],
                ) as requests, \
                patch("web.servidor.time.sleep") as sleep:
            with urlopen(request) as response:
                data = json.loads(response.read())

        self.assertEqual(data["status"], "success")
        self.assertEqual(data["result_image_url"], result_image_url)
        self.assertEqual(requests.call_count, 5)
        sleep.assert_called_once_with(5)
        self.assertEqual(
            requests.call_args_list[1][0][0].full_url,
            CATALOG_IMAGES_BY_URL[product.url],
        )
        rapidapi_request = requests.call_args_list[2][0][0]
        self.assertEqual(
            rapidapi_request.full_url,
            "https://try-on-clothes-pro.p.rapidapi.com/"
            "portrait/editing/try-on-clothes-pro",
        )
        self.assertIn(b'name="task_type"\r\n\r\nasync', rapidapi_request.data)
        self.assertIn(b'name="resolution"\r\n\r\n1024', rapidapi_request.data)
        self.assertIn(
            b'name="person_image"; filename="person.jpg"',
            rapidapi_request.data,
        )
        self.assertIn(
            b'name="top_garment"; filename="top-garment.jpg"',
            rapidapi_request.data,
        )
        self.assertNotIn(b'name="bottom_garment"', rapidapi_request.data)
        self.assertEqual(
            requests.call_args_list[3][0][0].get_method(),
            "GET",
        )
        self.assertIn(
            "query-async-task-result?task_id=task-123",
            requests.call_args_list[4][0][0].full_url,
        )
        self.assertEqual(
            dict((key.lower(), value) for key, value in rapidapi_request.header_items())[
                "x-rapidapi-key"
            ],
            "rapidapi-secret",
        )
        self.assertEqual(
            dict((key.lower(), value) for key, value in rapidapi_request.header_items())[
                "x-rapidapi-host"
            ],
            "try-on-clothes-pro.p.rapidapi.com",
        )

    def test_virtual_try_on_combines_one_upper_and_one_lower_garment(self):
        server = self.start_server()
        top_product = next(
            product
            for product in CATALOG_PRODUCTS
            if _virtual_try_on_category(product) == "upper_body"
            and CATALOG_IMAGES_BY_URL.get(product.url)
        )
        bottom_product = next(
            product
            for product in CATALOG_PRODUCTS
            if _virtual_try_on_category(product) == "lower_body"
            and CATALOG_IMAGES_BY_URL.get(product.url)
        )
        person_image = _jpeg_fixture()
        top_image = _jpeg_fixture(320, 420)
        bottom_image = _jpeg_fixture(420, 320)
        request = Request(
            f"http://127.0.0.1:{server.server_port}/api/try-on",
            data=json.dumps(
                {
                    "person_image_base64": base64.b64encode(
                        person_image
                    ).decode("ascii"),
                    "product_urls": [top_product.url, bottom_product.url],
                }
            ).encode("utf-8"),
            headers={
                "Authorization": "Bearer supabase-access-token",
                "Content-Type": "application/json",
            },
            method="POST",
        )

        download_barrier = threading.Barrier(2)

        def download_garment(image_url):
            download_barrier.wait(timeout=5)
            return (
                top_image
                if image_url == CATALOG_IMAGES_BY_URL[top_product.url]
                else bottom_image
            )

        with patch("web.servidor.SUPABASE_URL", "https://supabase.example"), \
                patch("web.servidor.SUPABASE_PUBLISHABLE_KEY", "publishable-key"), \
                patch("web.servidor.RAPIDAPI_KEY", "rapidapi-secret"), \
                patch(
                    "web.servidor._download_catalog_image",
                    side_effect=download_garment,
                ) as downloads, \
                patch(
                    "web.servidor.urlopen",
                    side_effect=[
                        _FakeResponse(b'{"id":"user-123"}'),
                        _FakeResponse(b'{"error_code":0,"task_id":"task-pair"}'),
                        _FakeResponse(
                            b'{"error_code":0,"task_status":2,'
                            b'"output":{"image_url":"https://images.example/result.jpg"}}'
                        ),
                    ],
                ) as requests:
            with urlopen(request) as response:
                data = json.loads(response.read())

        self.assertEqual(data["status"], "success")
        self.assertEqual(requests.call_count, 3)
        self.assertEqual(downloads.call_count, 2)
        self.assertEqual(
            {call.args[0] for call in downloads.call_args_list},
            {
                CATALOG_IMAGES_BY_URL[top_product.url],
                CATALOG_IMAGES_BY_URL[bottom_product.url],
            },
        )
        rapidapi_request = requests.call_args_list[1][0][0]
        self.assertIn(
            b'name="top_garment"; filename="top-garment.jpg"',
            rapidapi_request.data,
        )
        self.assertIn(
            b'name="bottom_garment"; filename="bottom-garment.jpg"',
            rapidapi_request.data,
        )

    def test_virtual_try_on_reports_rapidapi_rate_limit_without_retrying(self):
        server = self.start_server()
        product = next(
            product
            for product in CATALOG_PRODUCTS
            if _virtual_try_on_category(product) == "upper_body"
            and CATALOG_IMAGES_BY_URL.get(product.url)
        )
        person_image = _jpeg_fixture()
        rapidapi_error = HTTPError(
            "https://try-on-clothes-pro.p.rapidapi.com/portrait/editing/"
            "try-on-clothes-pro",
            429,
            "Too Many Requests",
            {"Retry-After": "30"},
            BytesIO(b'{"message":"Rate limit exceeded"}'),
        )
        request = Request(
            f"http://127.0.0.1:{server.server_port}/api/try-on",
            data=json.dumps(
                {
                    "person_image_base64": base64.b64encode(
                        person_image
                    ).decode("ascii"),
                    "product_url": product.url,
                }
            ).encode("utf-8"),
            headers={
                "Authorization": "Bearer supabase-access-token",
                "Content-Type": "application/json",
            },
            method="POST",
        )

        with patch("web.servidor.SUPABASE_URL", "https://supabase.example"), \
                patch("web.servidor.SUPABASE_PUBLISHABLE_KEY", "publishable-key"), \
                patch("web.servidor.RAPIDAPI_KEY", "rapidapi-secret"), \
                patch(
                    "web.servidor._supports_datatobiz_fallback",
                    return_value=False,
                ), \
                patch(
                    "web.servidor.urlopen",
                    side_effect=[
                        _FakeResponse(b'{"id":"user-123"}'),
                        _FakeResponse(person_image),
                        rapidapi_error,
                    ],
                ) as requests:
            with self.assertRaises(HTTPError) as error:
                urlopen(request)
            response_data = json.loads(error.exception.read())

        self.assertEqual(error.exception.code, 429)
        self.assertIn("minuto/segundo", response_data["error"])
        self.assertIn("Rate limit exceeded", response_data["error"])
        self.assertIn("Reintenta después de: 30", response_data["error"])
        self.assertIn("no admite prendas inferiores", response_data["error"])
        self.assertEqual(requests.call_count, 3)

    def test_virtual_try_on_uses_datatobiz_after_primary_failure(self):
        server = self.start_server()
        product = next(
            product
            for product in CATALOG_PRODUCTS
            if _virtual_try_on_category(product) == "upper_body"
            and CATALOG_IMAGES_BY_URL.get(product.url)
        )
        person_image = _jpeg_fixture()
        garment_image = _jpeg_fixture(320, 420)
        rapidapi_error = HTTPError(
            "https://try-on-clothes-pro.p.rapidapi.com/portrait/editing/"
            "try-on-clothes-pro",
            429,
            "Too Many Requests",
            {},
            BytesIO(b'{"message":"Rate limit exceeded"}'),
        )
        request = Request(
            f"http://127.0.0.1:{server.server_port}/api/try-on",
            data=json.dumps(
                {
                    "person_image_base64": base64.b64encode(
                        person_image
                    ).decode("ascii"),
                    "product_url": product.url,
                }
            ).encode("utf-8"),
            headers={
                "Authorization": "Bearer supabase-access-token",
                "Content-Type": "application/json",
            },
            method="POST",
        )

        with patch("web.servidor.SUPABASE_URL", "https://supabase.example"), \
                patch("web.servidor.SUPABASE_PUBLISHABLE_KEY", "publishable-key"), \
                patch("web.servidor.RAPIDAPI_KEY", "rapidapi-secret"), \
                patch(
                    "web.servidor.DATATOBIZ_RAPIDAPI_KEY",
                    "datatobiz-secret",
                ), \
                patch(
                    "web.servidor._download_catalog_image",
                    return_value=garment_image,
                ) as downloads, \
                patch(
                    "web.servidor.urlopen",
                    side_effect=[
                        _FakeResponse(b'{"id":"user-123"}'),
                        rapidapi_error,
                        _FakeResponse(
                            b'{"image_url":"https://images.example/result.jpg"}',
                            {"Content-Type": "application/json"},
                        ),
                    ],
                ) as requests:
            with urlopen(request) as response:
                data = json.loads(response.read())

        self.assertEqual(data["status"], "success")
        self.assertEqual(
            data["detail"],
            "Resultado Probador (respaldo DataToBiz)",
        )
        self.assertEqual(
            data["result_image_url"],
            "https://images.example/result.jpg",
        )
        self.assertEqual(downloads.call_count, 2)
        self.assertEqual(requests.call_count, 3)
        primary_request = requests.call_args_list[1][0][0]
        fallback_request = requests.call_args_list[2][0][0]
        self.assertEqual(
            fallback_request.full_url,
            "https://virtual-try-on2.p.rapidapi.com/clothes-virtual-tryon",
        )
        self.assertIn(
            b'name="personImage"; filename="person.jpg"',
            fallback_request.data,
        )
        self.assertIn(
            b'name="clothImage"; filename="cloth.jpg"',
            fallback_request.data,
        )
        fallback_headers = {
            key.lower(): value for key, value in fallback_request.header_items()
        }
        self.assertEqual(
            fallback_headers["x-rapidapi-host"],
            "virtual-try-on2.p.rapidapi.com",
        )
        self.assertEqual(
            fallback_headers["x-rapidapi-key"],
            "datatobiz-secret",
        )
        self.assertEqual(
            primary_request.full_url,
            "https://try-on-clothes-pro.p.rapidapi.com/"
            "portrait/editing/try-on-clothes-pro",
        )

    def test_virtual_try_on_can_use_datatobiz_without_primary_key(self):
        server = self.start_server()
        product = next(
            product
            for product in CATALOG_PRODUCTS
            if _virtual_try_on_category(product) == "upper_body"
            and CATALOG_IMAGES_BY_URL.get(product.url)
        )
        person_image = _jpeg_fixture()
        request = Request(
            f"http://127.0.0.1:{server.server_port}/api/try-on",
            data=json.dumps(
                {
                    "person_image_base64": base64.b64encode(
                        person_image
                    ).decode("ascii"),
                    "product_url": product.url,
                    "provider": "datatobiz",
                }
            ).encode("utf-8"),
            headers={
                "Authorization": "Bearer supabase-access-token",
                "Content-Type": "application/json",
            },
            method="POST",
        )

        with patch("web.servidor.SUPABASE_URL", "https://supabase.example"), \
                patch("web.servidor.SUPABASE_PUBLISHABLE_KEY", "publishable-key"), \
                patch("web.servidor.RAPIDAPI_KEY", ""), \
                patch(
                    "web.servidor.DATATOBIZ_RAPIDAPI_KEY",
                    "datatobiz-secret",
                ), \
                patch(
                    "web.servidor._download_catalog_image",
                    return_value=_jpeg_fixture(320, 420),
                ), \
                patch(
                    "web.servidor.urlopen",
                    side_effect=[
                        _FakeResponse(b'{"id":"user-123"}'),
                        _FakeResponse(
                            b'{"image_url":"https://images.example/result.jpg"}',
                            {"Content-Type": "application/json"},
                        ),
                    ],
                ) as requests:
            with urlopen(request) as response:
                data = json.loads(response.read())

        self.assertEqual(data["status"], "success")
        self.assertEqual(data["detail"], "Resultado Probador (DataToBiz)")
        self.assertEqual(requests.call_count, 2)
        provider_request = requests.call_args_list[1][0][0]
        self.assertEqual(
            provider_request.full_url,
            "https://virtual-try-on2.p.rapidapi.com/clothes-virtual-tryon",
        )
        headers = {
            key.lower(): value for key, value in provider_request.header_items()
        }
        self.assertEqual(headers["x-rapidapi-key"], "datatobiz-secret")

    def test_datatobiz_direct_error_includes_provider_response_detail(self):
        server = self.start_server()
        product = next(
            product
            for product in CATALOG_PRODUCTS
            if _virtual_try_on_category(product) == "upper_body"
            and CATALOG_IMAGES_BY_URL.get(product.url)
        )
        person_image = _jpeg_fixture()
        provider_error = HTTPError(
            "https://virtual-try-on2.p.rapidapi.com/clothes-virtual-tryon",
            502,
            "Bad Gateway",
            {},
            BytesIO(b'{"message":"upstream unavailable"}'),
        )
        request = Request(
            f"http://127.0.0.1:{server.server_port}/api/try-on",
            data=json.dumps(
                {
                    "person_image_base64": base64.b64encode(
                        person_image
                    ).decode("ascii"),
                    "product_url": product.url,
                    "provider": "datatobiz",
                }
            ).encode("utf-8"),
            headers={
                "Authorization": "Bearer supabase-access-token",
                "Content-Type": "application/json",
            },
            method="POST",
        )

        with patch("web.servidor.SUPABASE_URL", "https://supabase.example"), \
                patch("web.servidor.SUPABASE_PUBLISHABLE_KEY", "publishable-key"), \
                patch("web.servidor.RAPIDAPI_KEY", "primary-secret"), \
                patch(
                    "web.servidor.DATATOBIZ_RAPIDAPI_KEY",
                    "datatobiz-secret",
                ), \
                patch(
                    "web.servidor._download_catalog_image",
                    return_value=_jpeg_fixture(320, 420),
                ), \
                patch(
                    "web.servidor.urlopen",
                    side_effect=[
                        _FakeResponse(b'{"id":"user-123"}'),
                        provider_error,
                    ],
                ) as requests:
            with self.assertRaises(HTTPError) as error:
                urlopen(request)
            data = json.loads(error.exception.read())

        self.assertEqual(error.exception.code, 502)
        self.assertIn("DataToBiz rechazó la solicitud (HTTP 502)", data["error"])
        self.assertIn("upstream unavailable", data["error"])
        self.assertEqual(requests.call_count, 2)
        self.assertIn(
            "virtual-try-on2.p.rapidapi.com",
            requests.call_args_list[1][0][0].full_url,
        )

    def test_virtual_try_on_can_use_primary_without_datatobiz_fallback(self):
        server = self.start_server()
        product = next(
            product
            for product in CATALOG_PRODUCTS
            if _virtual_try_on_category(product) == "upper_body"
            and CATALOG_IMAGES_BY_URL.get(product.url)
        )
        person_image = _jpeg_fixture()
        provider_error = HTTPError(
            "https://try-on-clothes-pro.p.rapidapi.com/portrait/editing/"
            "try-on-clothes-pro",
            429,
            "Too Many Requests",
            {},
            BytesIO(b'{"message":"monthly quota exceeded"}'),
        )
        request = Request(
            f"http://127.0.0.1:{server.server_port}/api/try-on",
            data=json.dumps(
                {
                    "person_image_base64": base64.b64encode(
                        person_image
                    ).decode("ascii"),
                    "product_url": product.url,
                    "provider": "rapidapi",
                }
            ).encode("utf-8"),
            headers={
                "Authorization": "Bearer supabase-access-token",
                "Content-Type": "application/json",
            },
            method="POST",
        )

        with patch("web.servidor.SUPABASE_URL", "https://supabase.example"), \
                patch("web.servidor.SUPABASE_PUBLISHABLE_KEY", "publishable-key"), \
                patch("web.servidor.RAPIDAPI_KEY", "primary-secret"), \
                patch(
                    "web.servidor.DATATOBIZ_RAPIDAPI_KEY",
                    "datatobiz-secret",
                ), \
                patch(
                    "web.servidor.urlopen",
                    side_effect=[
                        _FakeResponse(b'{"id":"user-123"}'),
                        _FakeResponse(_jpeg_fixture(320, 420)),
                        provider_error,
                    ],
                ) as requests:
            with self.assertRaises(HTTPError) as error:
                urlopen(request)
            data = json.loads(error.exception.read())

        self.assertEqual(error.exception.code, 429)
        self.assertIn("Try on Clothes Pro", data["error"])
        self.assertIn("no se intenta DataToBiz", data["error"])
        self.assertEqual(requests.call_count, 3)
        self.assertIn(
            "try-on-clothes-pro.p.rapidapi.com",
            requests.call_args_list[2][0][0].full_url,
        )

    def test_virtual_try_on_uses_diffusion_with_an_independent_key(self):
        server = self.start_server()
        product = next(
            product
            for product in CATALOG_PRODUCTS
            if _virtual_try_on_category(product) == "upper_body"
            and CATALOG_IMAGES_BY_URL.get(product.url)
        )
        person_image = _jpeg_fixture()
        diffusion_image = _jpeg_fixture(420, 600)
        request = Request(
            f"http://127.0.0.1:{server.server_port}/api/try-on",
            data=json.dumps(
                {
                    "person_image_base64": base64.b64encode(
                        person_image
                    ).decode("ascii"),
                    "product_url": product.url,
                    "provider": "diffusion",
                }
            ).encode("utf-8"),
            headers={
                "Authorization": "Bearer supabase-access-token",
                "Content-Type": "application/json",
            },
            method="POST",
        )

        with patch("web.servidor.SUPABASE_URL", "https://supabase.example"), \
                patch("web.servidor.SUPABASE_PUBLISHABLE_KEY", "publishable-key"), \
                patch("web.servidor.RAPIDAPI_KEY", ""), \
                patch(
                    "web.servidor.RAPIDAPI_DIFFUSION_KEY",
                    "diffusion-secret",
                ), \
                patch(
                    "web.servidor._download_catalog_image",
                    return_value=_jpeg_fixture(320, 420),
                ), \
                patch(
                    "web.servidor.urlopen",
                    side_effect=[
                        _FakeResponse(b'{"id":"user-123"}'),
                        _FakeResponse(
                            diffusion_image,
                            {"Content-Type": "image/jpeg"},
                        ),
                    ],
                ) as requests:
            with urlopen(request) as response:
                data = json.loads(response.read())

        self.assertEqual(data["status"], "success")
        self.assertEqual(
            data["detail"],
            "Resultado Probador (Try-On Diffusion)",
        )
        self.assertTrue(data["result_image_data_url"].startswith("data:image/jpeg;base64,"))
        self.assertEqual(requests.call_count, 2)
        diffusion_request = requests.call_args_list[1][0][0]
        self.assertEqual(
            diffusion_request.full_url,
            "https://try-on-diffusion.p.rapidapi.com/try-on-file",
        )
        self.assertIn(
            b'name="avatar_image"; filename="avatar.jpg"',
            diffusion_request.data,
        )
        self.assertIn(
            b'name="clothing_image"; filename="clothing.jpg"',
            diffusion_request.data,
        )
        headers = {
            key.lower(): value for key, value in diffusion_request.header_items()
        }
        self.assertEqual(headers["x-rapidapi-key"], "diffusion-secret")
        self.assertEqual(
            headers["x-rapidapi-host"],
            "try-on-diffusion.p.rapidapi.com",
        )

    def test_virtual_try_on_refines_primary_result_with_clothes_refiner(self):
        server = self.start_server()
        product = next(
            product
            for product in CATALOG_PRODUCTS
            if _virtual_try_on_category(product) == "upper_body"
            and CATALOG_IMAGES_BY_URL.get(product.url)
        )
        person_image = _jpeg_fixture()
        request = Request(
            f"http://127.0.0.1:{server.server_port}/api/try-on",
            data=json.dumps(
                {
                    "person_image_base64": base64.b64encode(
                        person_image
                    ).decode("ascii"),
                    "product_url": product.url,
                    "provider": "refiner",
                    "gender": "man",
                }
            ).encode("utf-8"),
            headers={
                "Authorization": "Bearer supabase-access-token",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        coarse_url = "https://images.example/coarse.jpg"
        refined_url = "https://images.example/refined.jpg"

        with patch("web.servidor.SUPABASE_URL", "https://supabase.example"), \
                patch("web.servidor.SUPABASE_PUBLISHABLE_KEY", "publishable-key"), \
                patch("web.servidor.RAPIDAPI_KEY", "primary-secret"), \
                patch(
                    "web.servidor.RAPIDAPI_REFINER_KEY",
                    "refiner-secret",
                ), \
                patch(
                    "web.servidor._download_catalog_image",
                    return_value=_jpeg_fixture(320, 420),
                ) as downloads, \
                patch(
                    "web.servidor.urlopen",
                    side_effect=[
                        _FakeResponse(b'{"id":"user-123"}'),
                        _FakeResponse(
                            b'{"error_code":0,"task_id":"coarse-task"}'
                        ),
                        _FakeResponse(
                            json.dumps(
                                {
                                    "error_code": 0,
                                    "task_status": 2,
                                    "output": {"image_url": coarse_url},
                                }
                            ).encode("utf-8")
                        ),
                        _FakeResponse(
                            b'{"error_code":0,"task_id":"refiner-task"}'
                        ),
                        _FakeResponse(
                            json.dumps(
                                {
                                    "error_code": 0,
                                    "task_status": 2,
                                    "output": {"image_url": refined_url},
                                }
                            ).encode("utf-8")
                        ),
                    ],
                ) as requests, \
                patch("web.servidor.time.sleep"):
            with urlopen(request) as response:
                data = json.loads(response.read())

        self.assertEqual(data["status"], "success")
        self.assertEqual(
            data["detail"],
            "Resultado Probador (Try on Clothes Refiner)",
        )
        self.assertEqual(data["result_image_url"], refined_url)
        self.assertEqual(downloads.call_count, 3)
        self.assertEqual(requests.call_count, 5)
        primary_request = requests.call_args_list[1][0][0]
        refiner_request = requests.call_args_list[3][0][0]
        self.assertEqual(
            primary_request.full_url,
            "https://try-on-clothes-pro.p.rapidapi.com/"
            "portrait/editing/try-on-clothes-pro",
        )
        self.assertEqual(
            refiner_request.full_url,
            "https://try-on-clothes-refiner.p.rapidapi.com/"
            "portrait/enhance/try-on-clothes-refiner",
        )
        self.assertIn(b'name="coarse_image"; filename="coarse.jpg"', refiner_request.data)
        self.assertIn(b'name="person_image"; filename="person.jpg"', refiner_request.data)
        self.assertIn(b'name="top_garment"; filename="top-garment.jpg"', refiner_request.data)
        self.assertIn(b'name="gender"\r\n\r\nman', refiner_request.data)
        refiner_headers = {
            key.lower(): value for key, value in refiner_request.header_items()
        }
        self.assertEqual(refiner_headers["x-rapidapi-key"], "refiner-secret")
        self.assertEqual(
            refiner_headers["x-rapidapi-host"],
            "try-on-clothes-refiner.p.rapidapi.com",
        )

    def test_virtual_try_on_uses_photo_crop_for_bottom_garment_reference(self):
        server = self.start_server()
        product = next(
            product
            for product in CATALOG_PRODUCTS
            if _virtual_try_on_category(product) == "lower_body"
            and CATALOG_IMAGES_BY_URL.get(product.url)
        )
        person_image = _jpeg_fixture(600, 800)
        request = Request(
            f"http://127.0.0.1:{server.server_port}/api/try-on",
            data=json.dumps(
                {
                    "person_image_base64": base64.b64encode(
                        person_image
                    ).decode("ascii"),
                    "product_url": product.url,
                }
            ).encode("utf-8"),
            headers={
                "Authorization": "Bearer supabase-access-token",
                "Content-Type": "application/json",
            },
            method="POST",
        )

        with patch("web.servidor.SUPABASE_URL", "https://supabase.example"), \
                patch("web.servidor.SUPABASE_PUBLISHABLE_KEY", "publishable-key"), \
                patch("web.servidor.RAPIDAPI_KEY", "rapidapi-secret"), \
                patch(
                    "web.servidor.urlopen",
                    side_effect=[
                        _FakeResponse(b'{"id":"user-123"}'),
                        _FakeResponse(person_image),
                        _FakeResponse(b'{"error_code":0,"task_id":"task-456"}'),
                        _FakeResponse(
                            b'{"error_code":0,"task_status":2,'
                            b'"output":{"image_url":"https://images.example/result.jpg"}}'
                        ),
                    ],
                ) as requests:
            with urlopen(request) as response:
                data = json.loads(response.read())

        self.assertEqual(data["status"], "success")
        self.assertEqual(requests.call_count, 4)
        rapidapi_request = requests.call_args_list[2][0][0]
        self.assertIn(
            b'name="person_image"; filename="person.jpg"',
            rapidapi_request.data,
        )
        self.assertIn(
            b'name="top_garment"; filename="top-garment.jpg"',
            rapidapi_request.data,
        )
        self.assertIn(
            b'name="bottom_garment"; filename="bottom-garment.jpg"',
            rapidapi_request.data,
        )
        self.assertEqual(
            requests.call_args_list[1][0][0].full_url,
            CATALOG_IMAGES_BY_URL[product.url],
        )


if __name__ == "__main__":
    unittest.main()

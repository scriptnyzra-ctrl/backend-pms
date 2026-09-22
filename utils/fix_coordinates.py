import sys
import json
import requests
import re
import time
from bs4 import BeautifulSoup
from urllib.parse import quote

ADMIN_PANEL_BASE = "https://adminpanel.rideblitz.id"
GOOGLE_MAPS_KEY = "AIzaSyD4sgjH4RAaAokyujwQO_jSeZDowQ1U9Oo"

COORD_BOUNDS = {
    "lat_min": -6.5,
    "lat_max": -5.9,
    "lon_min": 106.6,
    "lon_max": 107.1,
}

HEADERS = {
    "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
    "accept-encoding": "gzip, deflate, br, zstd",
    "accept-language": "en-US,en;q=0.9,id;q=0.8",
    "connection": "keep-alive",
    "host": "adminpanel.rideblitz.id",
    "sec-ch-ua": '"Chromium";v="146", "Not-A.Brand";v="24", "Google Chrome";v="146"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "document",
    "sec-fetch-mode": "navigate",
    "sec-fetch-site": "same-origin",
    "sec-fetch-user": "?1",
    "upgrade-insecure-requests": "1",
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
}

MAX_SESSION_RETRIES = 3
MAX_ORDER_RETRIES = 3
SESSION_RETRY_DELAY = 5
ORDER_RETRY_DELAY = 3
REQUEST_TIMEOUT = 30
BETWEEN_ORDERS_DELAY = 1.0


def flush_partial_result(result):
    line = json.dumps({"results": [result]})
    sys.stdout.write(line + "\n")
    sys.stdout.flush()


def is_coord_valid(value):
    if not value:
        return False
    try:
        return float(value) != 0.0
    except (ValueError, TypeError):
        return False


def is_coord_in_bounds(lat, lng):
    try:
        lat, lng = float(lat), float(lng)
        return (
            COORD_BOUNDS["lat_min"] <= lat <= COORD_BOUNDS["lat_max"]
            and COORD_BOUNDS["lon_min"] <= lng <= COORD_BOUNDS["lon_max"]
        )
    except (TypeError, ValueError):
        return False


def get_address_candidates(raw_address):
    url = (
        "https://maps.googleapis.com/maps/api/geocode/json"
        f"?address={quote(raw_address)}"
        f"&key={GOOGLE_MAPS_KEY}&region=id&language=id"
    )
    for attempt in range(3):
        try:
            resp = requests.get(url, timeout=10)
            data = resp.json()
            if data.get("status") == "OK":
                candidates = []
                for result in data.get("results", []):
                    formatted = result["formatted_address"]
                    loc = result["geometry"]["location"]
                    candidates.append({
                        "address": formatted,
                        "lat": loc["lat"],
                        "lng": loc["lng"],
                    })
                return candidates
            break
        except Exception:
            if attempt < 2:
                time.sleep(2)
    return []


def build_address_variants(raw_address, candidates, city=None, district=None):
    variants = []

    for c in candidates:
        variants.append(c["address"])

    city_str = city or district or "Jakarta Selatan"

    parts = re.split(r',\s*', raw_address)
    for i in range(len(parts), 0, -1):
        simplified = ", ".join(parts[:i])
        candidate = f"{simplified}, {city_str}, Indonesia"
        if candidate not in variants:
            variants.append(candidate)

    street_match = re.match(
        r'^(JL\.?\s+[\w\s]+?)(?:\s+(?:RT|GG|NO|KAV|BLOK))',
        raw_address,
        re.IGNORECASE,
    )
    if street_match:
        street_only = street_match.group(1).strip()
        variants.append(f"{street_only}, {city_str}, Indonesia")
        variants.append(f"{street_only}, Jakarta, Indonesia")

    variants.append(f"{raw_address}, {city_str}, Indonesia")
    variants.append(f"{raw_address}, Jakarta, Indonesia")
    variants.append(f"{raw_address}, Indonesia")
    variants.append(raw_address)

    seen = []
    for v in variants:
        clean = v.strip()
        if clean and clean not in seen:
            seen.append(clean)
    return seen


def get_session_with_retry(username, password):
    last_error = None
    for attempt in range(MAX_SESSION_RETRIES):
        try:
            session = get_session(username, password)
            return session
        except Exception as e:
            last_error = e
            if attempt < MAX_SESSION_RETRIES - 1:
                time.sleep(SESSION_RETRY_DELAY * (attempt + 1))
    raise last_error


def get_session(username, password):
    session = requests.Session()
    session.headers.update({"user-agent": HEADERS["user-agent"]})

    login_page = session.get(
        f"{ADMIN_PANEL_BASE}/login/",
        headers=HEADERS,
        timeout=REQUEST_TIMEOUT,
        allow_redirects=True,
    )

    csrf_token = ""
    csrf_m = re.search(r'name="csrfmiddlewaretoken"\s+value="([^"]+)"', login_page.text)
    if csrf_m:
        csrf_token = csrf_m.group(1)
    else:
        csrf_token = session.cookies.get("csrftoken", "")

    if not csrf_token:
        raise Exception("CSRF token tidak ditemukan di halaman login AdminPanel")

    login_data = {
        "csrfmiddlewaretoken": csrf_token,
        "username": username,
        "password": password,
        "next": "/",
    }

    post_headers = {
        **HEADERS,
        "cache-control": "max-age=0",
        "content-type": "application/x-www-form-urlencoded",
        "origin": ADMIN_PANEL_BASE,
        "referer": f"{ADMIN_PANEL_BASE}/login/",
    }

    resp = session.post(
        f"{ADMIN_PANEL_BASE}/login/",
        data=login_data,
        headers=post_headers,
        allow_redirects=True,
        timeout=REQUEST_TIMEOUT,
    )

    if "/login/" in resp.url and "logout" not in resp.text.lower():
        raise Exception("Login AdminPanel gagal — periksa username/password Blitz")

    return session


def search_order(session, merchant_order_id, consignee_name, retry_count=0):
    q = f"{merchant_order_id}-{consignee_name}" if consignee_name else merchant_order_id
    url = f"{ADMIN_PANEL_BASE}/api/order/?q={quote(q)}"
    try:
        resp = session.get(url, headers={**HEADERS, "referer": url}, timeout=REQUEST_TIMEOUT)
        soup = BeautifulSoup(resp.text, "html.parser")
        rows = soup.select("#result_list tbody tr")
        order_ids = []
        for row in rows:
            link = row.find("a", href=True)
            if link:
                parts = link["href"].strip("/").split("/")
                for i, p in enumerate(parts):
                    if p == "change" and i > 0:
                        order_ids.append(parts[i - 1])
                        break
        return order_ids
    except requests.exceptions.RequestException as e:
        if retry_count < 2:
            time.sleep(ORDER_RETRY_DELAY)
            return search_order(session, merchant_order_id, consignee_name, retry_count + 1)
        raise e


def get_page_data(session, order_id, q_filter, retry_count=0):
    encoded_filter = quote(f"q={quote(q_filter, safe='')}", safe="=")
    change_url = f"{ADMIN_PANEL_BASE}/api/order/{order_id}/change/?_changelist_filters={encoded_filter}"
    try:
        resp = session.get(change_url, headers=HEADERS, timeout=REQUEST_TIMEOUT)
        soup = BeautifulSoup(resp.text, "html.parser")

        csrf_input = soup.find("input", {"name": "csrfmiddlewaretoken"})
        csrf_token = csrf_input["value"] if csrf_input else session.cookies.get("csrftoken", "")

        def extract_input(name):
            tag = soup.find("input", {"name": name})
            if tag:
                return tag.get("value", "")
            tag = soup.find("textarea", {"name": name})
            if tag:
                return tag.get_text()
            return ""

        def extract_select(name):
            tag = soup.find("select", {"name": name})
            if tag:
                selected = tag.find("option", selected=True)
                if selected:
                    return selected.get("value", "")
                first = tag.find("option")
                if first:
                    return first.get("value", "")
            return ""

        return {
            "csrf_token": csrf_token,
            "order_status": extract_select("order_status") or "1",
            "cancel_reason": extract_input("cancel_reason"),
            "package_weight": extract_input("package_weight") or "1.00",
            "package_width": extract_input("package_width") or "0",
            "package_length": extract_input("package_length") or "0",
            "package_height": extract_input("package_height") or "0",
            "pickup_address": extract_input("pickup_address"),
            "pickup_postal_code": extract_input("pickup_postal_code") or "12345",
            "pickup_lat": extract_input("pickup_lat"),
            "pickup_long": extract_input("pickup_long"),
            "dropoff_postal_code": extract_input("dropoff_postal_code") or "12345",
            "sender_name": extract_input("sender_name"),
            "sender_phone_number": extract_input("sender_phone_number"),
            "consignee_name": extract_input("consignee_name"),
            "consignee_phone_number": extract_input("consignee_phone_number"),
            "business_hub": extract_select("business_hub") or extract_input("business_hub") or "178",
        }
    except requests.exceptions.RequestException as e:
        if retry_count < 2:
            time.sleep(ORDER_RETRY_DELAY)
            return get_page_data(session, order_id, q_filter, retry_count + 1)
        raise e


def check_coordinate_valid(session, order_id, q_filter, retry_count=0):
    encoded_filter = quote(f"q={quote(q_filter, safe='')}", safe="=")
    change_url = f"{ADMIN_PANEL_BASE}/api/order/{order_id}/change/?_changelist_filters={encoded_filter}"
    try:
        resp = session.get(change_url, headers=HEADERS, timeout=REQUEST_TIMEOUT)
        soup = BeautifulSoup(resp.text, "html.parser")
        lat_input = soup.find("input", {"name": "dropoff_lat"})
        long_input = soup.find("input", {"name": "dropoff_long"})
        lat_val = lat_input.get("value", "") if lat_input else ""
        long_val = long_input.get("value", "") if long_input else ""
        return is_coord_valid(lat_val) and is_coord_valid(long_val), lat_val, long_val
    except requests.exceptions.RequestException as e:
        if retry_count < 2:
            time.sleep(ORDER_RETRY_DELAY)
            return check_coordinate_valid(session, order_id, q_filter, retry_count + 1)
        raise e


def submit_address(session, order_id, q_filter, page_data, dropoff_address, retry_count=0):
    encoded_filter = quote(f"q={quote(q_filter, safe='')}", safe="=")
    change_url = f"{ADMIN_PANEL_BASE}/api/order/{order_id}/change/?_changelist_filters={encoded_filter}"

    payload = {
        "csrfmiddlewaretoken": page_data["csrf_token"],
        "order_status": page_data["order_status"] or "1",
        "cancel_reason": page_data["cancel_reason"],
        "package_weight": page_data["package_weight"] or "1.00",
        "package_width": page_data["package_width"] or "0",
        "package_length": page_data["package_length"] or "0",
        "package_height": page_data["package_height"] or "0",
        "pickup_address": page_data["pickup_address"],
        "pickup_postal_code": page_data["pickup_postal_code"] or "12345",
        "pickup_lat": page_data["pickup_lat"],
        "pickup_long": page_data["pickup_long"],
        "dropoff_address": dropoff_address,
        "dropoff_postal_code": page_data["dropoff_postal_code"] or "12345",
        "sender_name": page_data["sender_name"],
        "sender_phone_number": page_data["sender_phone_number"],
        "consignee_name": page_data["consignee_name"],
        "consignee_phone_number": page_data["consignee_phone_number"],
        "business_hub": page_data["business_hub"] or "178",
        "_continue": "Save",
    }

    post_headers = {
        **HEADERS,
        "cache-control": "max-age=0",
        "content-type": "application/x-www-form-urlencoded",
        "origin": ADMIN_PANEL_BASE,
        "referer": change_url,
    }

    try:
        resp = session.post(change_url, headers=post_headers, data=payload, allow_redirects=True, timeout=REQUEST_TIMEOUT)

        soup_after = BeautifulSoup(resp.text, "html.parser")
        error_note = soup_after.find(class_="errornote")
        field_errors = soup_after.find_all(class_="errorlist")

        if error_note or field_errors:
            return False

        return resp.status_code == 200
    except requests.exceptions.RequestException as e:
        if retry_count < 2:
            time.sleep(ORDER_RETRY_DELAY)
            page_data_fresh = get_page_data(session, order_id, q_filter)
            if page_data_fresh and page_data_fresh.get("csrf_token"):
                return submit_address(session, order_id, q_filter, page_data_fresh, dropoff_address, retry_count + 1)
        return False


def is_session_valid(session):
    try:
        resp = session.get(f"{ADMIN_PANEL_BASE}/api/order/", headers=HEADERS, timeout=15, allow_redirects=True)
        return "/login/" not in resp.url
    except Exception:
        return False


def process_order_with_retry(session, order, username, password):
    last_error = None
    for attempt in range(MAX_ORDER_RETRIES):
        try:
            if attempt > 0:
                if not is_session_valid(session):
                    session = get_session_with_retry(username, password)
                time.sleep(ORDER_RETRY_DELAY * attempt)

            result = process_order(session, order)

            if result.get("success"):
                return result, session

            if "tidak ditemukan" in result.get("message", "").lower():
                return result, session

            last_error = result.get("message", "Unknown error")

        except requests.exceptions.ConnectionError as e:
            last_error = f"Connection error: {str(e)}"
            if attempt < MAX_ORDER_RETRIES - 1:
                time.sleep(SESSION_RETRY_DELAY * (attempt + 1))
                try:
                    session = get_session_with_retry(username, password)
                except Exception:
                    pass
        except requests.exceptions.Timeout as e:
            last_error = f"Timeout: {str(e)}"
            if attempt < MAX_ORDER_RETRIES - 1:
                time.sleep(SESSION_RETRY_DELAY * (attempt + 1))
        except Exception as e:
            last_error = str(e)
            if attempt < MAX_ORDER_RETRIES - 1:
                time.sleep(ORDER_RETRY_DELAY * (attempt + 1))

    merchant_order_id = order.get("merchantOrderId", "")
    return {
        "merchantOrderId": merchant_order_id,
        "success": False,
        "message": f"Gagal setelah {MAX_ORDER_RETRIES} percobaan: {last_error}",
    }, session


def process_order(session, order):
    merchant_order_id = order.get("merchantOrderId", "")
    consignee_name = order.get("consigneeName", "")
    destination_address = order.get("destinationAddress", "")
    destination_city = order.get("destinationCity", "")
    destination_district = order.get("destinationDistrict", "")

    if not merchant_order_id:
        return {"merchantOrderId": merchant_order_id, "success": False, "message": "merchantOrderId kosong"}

    q_filter = f"{merchant_order_id}-{consignee_name}" if consignee_name else merchant_order_id
    order_ids = search_order(session, merchant_order_id, consignee_name)

    if not order_ids:
        order_ids = search_order(session, merchant_order_id, "")

    if not order_ids:
        return {"merchantOrderId": merchant_order_id, "success": False, "message": "Order tidak ditemukan di AdminPanel"}

    order_id = order_ids[0]

    candidates = get_address_candidates(destination_address) if destination_address else []
    address_variants = build_address_variants(destination_address, candidates, destination_city, destination_district)

    for idx, address_to_try in enumerate(address_variants):
        page_data = get_page_data(session, order_id, q_filter)
        if not page_data or not page_data.get("csrf_token"):
            time.sleep(2)
            page_data = get_page_data(session, order_id, q_filter)
            if not page_data or not page_data.get("csrf_token"):
                return {"merchantOrderId": merchant_order_id, "success": False, "message": "Gagal mengambil data halaman AdminPanel"}

        success = submit_address(session, order_id, q_filter, page_data, address_to_try)
        if not success:
            continue

        time.sleep(3)

        coord_valid, lat_val, long_val = check_coordinate_valid(session, order_id, q_filter)

        if coord_valid and is_coord_in_bounds(lat_val, long_val):
            return {
                "merchantOrderId": merchant_order_id,
                "success": True,
                "lat": float(lat_val),
                "lng": float(long_val),
                "message": "Koordinat diperbarui",
            }

        time.sleep(1)

    return {
        "merchantOrderId": merchant_order_id,
        "success": False,
        "message": f"Semua {len(address_variants)} varian alamat gagal menghasilkan koordinat valid",
    }


def main():
    raw = sys.stdin.read()
    payload = json.loads(raw)

    username = payload["username"]
    password = payload["password"]
    orders = payload["orders"]

    try:
        session = get_session_with_retry(username, password)
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e), "results": []}))
        sys.exit(1)

    all_results = []
    session_refresh_counter = 0

    for idx, order in enumerate(orders):
        result, session = process_order_with_retry(session, order, username, password)
        all_results.append(result)

        flush_partial_result(result)

        session_refresh_counter += 1
        if session_refresh_counter >= 10:
            session_refresh_counter = 0
            try:
                if not is_session_valid(session):
                    session = get_session_with_retry(username, password)
            except Exception:
                pass

        if idx < len(orders) - 1:
            time.sleep(BETWEEN_ORDERS_DELAY)

    success_count = sum(1 for r in all_results if r["success"])
    final_output = json.dumps({
        "success": success_count > 0,
        "results": all_results,
        "successCount": success_count,
        "failCount": len(all_results) - success_count,
    })
    sys.stdout.write(final_output + "\n")
    sys.stdout.flush()


if __name__ == "__main__":
    main()
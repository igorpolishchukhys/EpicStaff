import requests
from loguru import logger

from core.config import settings


_api_key_validated = False


def validate_api_key() -> bool:
    global _api_key_validated
    if _api_key_validated:
        return True
    try:
        resp = requests.get(
            f"{settings.DJANGO_AUTH_URL}/api/auth/api-key/validate/",
            headers={"X-API-Key": settings.DJANGO_API_KEY},
            timeout=settings.DJANGO_AUTH_TIMEOUT,
        )
    except Exception:
        logger.warning("API key validation request failed")
        return False

    if resp.status_code != 200:
        logger.warning(f"API key validation failed with status {resp.status_code}")
        return False

    data = resp.json()
    if not data.get("active"):
        logger.warning("API key validation returned inactive")
        return False

    _api_key_validated = True
    return True


def introspect_token(
    token: str,
    flow_id: int | None = None,
    org_id: int | None = None,
) -> dict | None:
    """Introspect a JWT access token via Django.

    When both ``flow_id`` and ``org_id`` are supplied they are forwarded to
    the Django endpoint which adds a ``can_edit`` boolean to the response.
    When either is absent the optional context is not sent and the response
    is identical to the pre-EST-11 shape.

    Returns the introspection dict on success, ``None`` on any failure.
    """
    if not validate_api_key():
        return None

    body: dict = {"token": token}
    if flow_id is not None and org_id is not None:
        body["flow_id"] = flow_id
        body["org_id"] = org_id

    try:
        resp = requests.post(
            f"{settings.DJANGO_AUTH_URL}/api/auth/introspect/",
            json=body,
            headers={"X-API-Key": settings.DJANGO_API_KEY},
            timeout=settings.DJANGO_AUTH_TIMEOUT,
        )
    except Exception:
        logger.warning("Token introspection request failed")
        return None

    if resp.status_code != 200:
        logger.warning("Token introspection failed with status {}", resp.status_code)
        return None

    data = resp.json()
    if not data.get("active"):
        logger.warning("Token introspection returned inactive")
        return None
    return data

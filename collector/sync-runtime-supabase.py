import json
import os
import ssl
import sys
import time
import urllib.request
import urllib.error


def main():
    root, runtime_path = sys.argv[1], sys.argv[2]
    for name in ("ALL_PROXY", "HTTP_PROXY", "HTTPS_PROXY", "all_proxy", "http_proxy", "https_proxy"):
        os.environ.pop(name, None)
    with open(os.path.join(root, "supabase-sync.json"), encoding="utf-8-sig") as handle:
        config = json.load(handle)
    for attempt in range(10):
        try:
            with open(runtime_path, encoding="utf-8-sig") as handle:
                runtime = json.load(handle)
            break
        except (PermissionError, json.JSONDecodeError):
            if attempt == 9:
                raise
            time.sleep(0.15)
    if runtime.get("balance") is None or not runtime.get("currency"):
        print(json.dumps({"runtime_sent": False, "reason": "balance unavailable"}))
        return
    base_payload = {
        "p_token": config["collectorToken"],
        "p_balance": runtime.get("balance"),
        "p_currency": runtime.get("currency"),
        "p_bet_active": bool(runtime.get("bet_active")),
        "p_live_multiplier": runtime.get("live_multiplier"),
        "p_status": runtime.get("status") or "sem aposta",
    }
    extended_payload = dict(base_payload)
    if runtime.get("round_id") is not None:
        extended_payload["p_round_id"] = str(runtime["round_id"])
    if runtime.get("bet_amount") is not None:
        extended_payload["p_bet_amount"] = runtime["bet_amount"]
    key = config["publishableKey"]
    endpoint = config["projectUrl"].rstrip("/") + "/rest/v1/rpc/upsert_crash_runtime_status"
    headers = {"apikey": key, "Authorization": "Bearer " + key, "Content-Type": "application/json"}
    for payload in (extended_payload, base_payload):
        request = urllib.request.Request(endpoint, data=json.dumps(payload).encode("utf-8"), method="POST", headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=15, context=ssl.create_default_context()) as response:
                response.read()
            print(json.dumps({"runtime_sent": True, "extended": payload is extended_payload}))
            return
        except urllib.error.HTTPError:
            if payload is base_payload:
                raise


if __name__ == "__main__":
    main()

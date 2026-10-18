import json
import os
import ssl
import sys
import time
import urllib.request


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
    body = json.dumps({
        "p_token": config["collectorToken"],
        "p_balance": runtime.get("balance"),
        "p_currency": runtime.get("currency"),
        "p_bet_active": bool(runtime.get("bet_active")),
        "p_live_multiplier": runtime.get("live_multiplier"),
        "p_status": runtime.get("status") or "sem aposta",
    }).encode("utf-8")
    key = config["publishableKey"]
    request = urllib.request.Request(
        config["projectUrl"].rstrip("/") + "/rest/v1/rpc/upsert_crash_runtime_status",
        data=body,
        method="POST",
        headers={"apikey": key, "Authorization": "Bearer " + key, "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=15, context=ssl.create_default_context()) as response:
        response.read()
    print(json.dumps({"runtime_sent": True}))


if __name__ == "__main__":
    main()

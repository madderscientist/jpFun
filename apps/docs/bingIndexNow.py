# 预览，不发送请求
# python apps\docs\bingIndexNow.py --dry-run
# 正式提交
# python apps\docs\bingIndexNow.py

import argparse
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import quote

HOST = "madderscientist.github.io"
KEY = "a6666dbb06dd4ababa2835189ef90a1d"
BASE_URL = f"https://{HOST}/jpFun/"
KEY_LOCATION = f"{BASE_URL}{KEY}.txt"
DIST_PATH = Path(__file__).resolve().parent / "dist"


def get_urls() -> list[str]:
    if not DIST_PATH.is_dir():
        raise FileNotFoundError(f"Site output not found: {DIST_PATH}. Run pnpm build first.")
    if not (DIST_PATH / "playground" / "index.html").is_file():
        raise FileNotFoundError("Playground output not found. Run pnpm build to assemble the full site.")
    if (DIST_PATH / f"{KEY}.txt").read_text(encoding="utf-8").strip() != KEY:
        raise ValueError("The built IndexNow key file does not match KEY.")

    urls = []
    for html_file in sorted(DIST_PATH.rglob("*.html")):
        rel_path = html_file.relative_to(DIST_PATH).as_posix()
        if rel_path == "404.html":
            continue
        url_path = rel_path.removesuffix("index.html") if html_file.name == "index.html" else rel_path
        urls.append(f"{BASE_URL}{quote(url_path, safe='/')}")

    if len(urls) > 10_000:
        raise ValueError("IndexNow accepts at most 10,000 URLs per request.")
    return urls


def main() -> int:
    parser = argparse.ArgumentParser(description="Submit the assembled docs and playground site to IndexNow.")
    parser.add_argument("--dry-run", action="store_true", help="Print the payload without submitting URLs.")
    args = parser.parse_args()

    try:
        urls = get_urls()
        payload = {"host": HOST, "key": KEY, "keyLocation": KEY_LOCATION, "urlList": urls}
        print(f"Found {len(urls)} URLs:")
        print(json.dumps(payload, indent=2))
        if args.dry_run:
            print("Dry run: no URLs submitted.")
            return 0

        request = urllib.request.Request(
            "https://api.indexnow.org/IndexNow",
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json; charset=utf-8"},
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=30) as response:
            status = response.status
            body = response.read().decode("utf-8", errors="replace")
            if status == 200:
                print("IndexNow received the URLs (HTTP 200); indexing is not guaranteed.")
            elif status == 202:
                print("IndexNow received the URLs; key validation is pending (HTTP 202).")
            else:
                raise ValueError(f"Unexpected IndexNow response: HTTP {status}: {body}")
            if body:
                print(body)
        return 0
    except urllib.error.HTTPError as error:
        body = error.read().decode("utf-8", errors="replace")
        print(f"IndexNow failed: HTTP {error.code}: {body}", file=sys.stderr)
        return 1
    except (OSError, ValueError) as error:
        print(f"IndexNow failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())

"""Small deployed-API smoke evaluation; no model calls run locally without credentials."""
import argparse
import json
import os
import sys
import urllib.error
import urllib.request

GOLDEN = [
    {"question": "What does the Security pillar recommend for IAM?", "source": "security.md"},
    {"question": "How should transient API failures be retried?", "source": "reliability.md"},
    {"question": "Is an API quota a spending cap?", "source": "cost.md"},
]


def check_result(result, source):
    """Require non-refusal output and a matching S3 citation, not just fluent text."""
    answer = result.get("answer", "")
    citations = result.get("citations", [])
    return (isinstance(answer, str) and bool(answer.strip())
            and "cannot answer" not in answer.lower()
            and isinstance(citations, list)
            and any(isinstance(item, dict) and isinstance(item.get("source"), str)
                    and item["source"].startswith("s3://")
                    and item["source"].endswith("/" + source) for item in citations))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", required=True, help="Deployed /ask HTTPS endpoint")
    args = parser.parse_args()
    api_key = os.environ.get("RAG_API_KEY")
    if not api_key:
        parser.error("set RAG_API_KEY in your shell (never commit its value)")
    if not args.url.startswith("https://"):
        parser.error("--url must be HTTPS")
    failures = 0
    for case in GOLDEN:
        request = urllib.request.Request(args.url,
                                         data=json.dumps({"question": case["question"]}).encode(),
                                         headers={"Content-Type": "application/json", "x-api-key": api_key},
                                         method="POST")
        try:
            with urllib.request.urlopen(request, timeout=40) as response:
                result = json.load(response)
            passed = check_result(result, case["source"])
        except (urllib.error.URLError, json.JSONDecodeError, TimeoutError) as exc:
            passed = False
            print(f"ERROR: {type(exc).__name__}", file=sys.stderr)
        print(f'{"PASS" if passed else "FAIL"}: {case["question"]} (expected {case["source"]})')
        failures += not passed
    print(f"{len(GOLDEN) - failures}/{len(GOLDEN)} expected-source checks passed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())

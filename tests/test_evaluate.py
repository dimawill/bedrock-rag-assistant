from scripts.evaluate import GOLDEN, check_result


def test_expected_source_passes():
    assert check_result({"answer": "Use least privilege [1].", "citations": [
        {"id": 1, "source": "s3://bucket/docs/security.md"}]}, GOLDEN[0]["source"])


def test_wrong_source_and_refusal_fail():
    assert not check_result({"answer": "Use IAM [1].", "citations": [
        {"source": "s3://bucket/docs/cost.md"}]}, "security.md")
    assert not check_result({"answer": "I cannot answer from documents.", "citations": [
        {"source": "s3://bucket/docs/security.md"}]}, "security.md")


def test_missing_or_malformed_citations_fail():
    assert not check_result({"answer": "IAM", "citations": []}, "security.md")
    assert not check_result({"answer": "IAM", "citations": ["security.md"]}, "security.md")
    assert not check_result({"answer": "IAM", "citations": [
        {"source": "https://example.org/security.md"}]}, "security.md")

"""
GAIA official scorer — quasi-exact-match with type-aware normalization.

Adapted from the official GAIA leaderboard scorer:
https://huggingface.co/spaces/gaia-benchmark/leaderboard/blob/main/scorer.py
"""

import re
import string


def normalize_number_str(number_str: str) -> float | None:
    """Try to parse a number string, stripping common formatting."""
    # Remove currency symbols, percent signs, commas, whitespace
    cleaned = number_str.replace(",", "").replace("$", "").replace("%", "").replace("€", "").replace("£", "").strip()
    try:
        return float(cleaned)
    except ValueError:
        return None


def normalize_str(input_str: str) -> str:
    """Normalize a string: lowercase, remove punctuation and whitespace."""
    # Remove articles
    no_articles = re.sub(r"\b(a|an|the)\b", " ", input_str.lower())
    # Remove punctuation
    no_punct = no_articles.translate(str.maketrans("", "", string.punctuation))
    # Remove extra whitespace
    normalized = " ".join(no_punct.split())
    # Remove all spaces for comparison
    return normalized.replace(" ", "")


def split_list(s: str) -> list[str]:
    """Split a list answer by comma or semicolon."""
    if ";" in s:
        return [item.strip() for item in s.split(";")]
    return [item.strip() for item in s.split(",")]


def question_scorer(model_answer: str, ground_truth: str) -> bool:
    """
    Score a model answer against ground truth.
    Returns True if the answer is correct.
    """
    if not model_answer or not ground_truth:
        return False

    model_answer = str(model_answer).strip()
    ground_truth = str(ground_truth).strip()

    # Try number comparison
    gt_num = normalize_number_str(ground_truth)
    if gt_num is not None:
        pred_num = normalize_number_str(model_answer)
        if pred_num is not None:
            return abs(pred_num - gt_num) < 1e-6
        # Ground truth is a number but model answer isn't parseable
        # Still try string comparison as fallback
        return normalize_str(model_answer) == normalize_str(ground_truth)

    # Try list comparison
    if "," in ground_truth or ";" in ground_truth:
        gt_items = split_list(ground_truth)
        pred_items = split_list(model_answer)

        if len(gt_items) != len(pred_items):
            return False

        for gt_item, pred_item in zip(gt_items, pred_items):
            # Try number comparison for each item
            gt_item_num = normalize_number_str(gt_item)
            if gt_item_num is not None:
                pred_item_num = normalize_number_str(pred_item)
                if pred_item_num is None or abs(pred_item_num - gt_item_num) >= 1e-6:
                    return False
            else:
                if normalize_str(pred_item) != normalize_str(gt_item):
                    return False
        return True

    # Plain string comparison
    return normalize_str(model_answer) == normalize_str(ground_truth)


if __name__ == "__main__":
    # Self-test
    assert question_scorer("42", "42") is True
    assert question_scorer("$1,234.56", "1234.56") is True
    assert question_scorer("Sea Gull", "seagull") is True
    assert question_scorer("The Beatles", "Beatles") is True
    assert question_scorer("apple,banana,cherry", "apple, banana, cherry") is True
    assert question_scorer("1;2;3", "1; 2; 3") is True
    assert question_scorer("wrong", "right") is False
    print("All scorer self-tests passed!")

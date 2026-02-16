#!/usr/bin/env python3
"""
GAIA Evaluation Harness for OpenClaw Layer 0.

Usage:
  # Run all levels on validation set
  python gaia-eval/eval.py

  # Run specific level
  python gaia-eval/eval.py --level 1

  # Use a different model
  python gaia-eval/eval.py --provider openai --model gpt-5.2

  # Limit number of questions (for testing)
  python gaia-eval/eval.py --limit 5

  # Resume from a specific task
  python gaia-eval/eval.py --resume-from <task_id>

Prerequisites:
  pip install datasets huggingface_hub
  export HF_TOKEN=hf_xxx  (for gated dataset access)
"""

import argparse
import json
import os
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

from scorer import question_scorer

# Resolve paths
SCRIPT_DIR = Path(__file__).parent.resolve()
PROJECT_ROOT = SCRIPT_DIR.parent
GAIA_CLI = PROJECT_ROOT / "src" / "gaia" / "cli.ts"
RESULTS_DIR = SCRIPT_DIR / "results"


def load_dataset_questions(data_dir: str, level: int | None, split: str = "validation"):
    """Load GAIA questions from HuggingFace dataset."""
    try:
        from datasets import load_dataset
    except ImportError:
        print("ERROR: Please install datasets: pip install datasets huggingface_hub")
        sys.exit(1)

    dataset = load_dataset(data_dir, "2023_all", split=split)
    questions = list(dataset)

    if level is not None:
        questions = [q for q in questions if q["Level"] == level]

    return questions


def run_agent(question: str, file_path: str | None, provider: str, model: str,
              thinking: str, timeout: int, workspace: str, api_key: str | None = None) -> dict:
    """Call the GAIA agent CLI and parse the JSON result."""
    cmd = [
        "npx", "tsx", str(GAIA_CLI),
        "--json",
        "--question", question,
        "--provider", provider,
        "--model", model,
        "--thinking", thinking,
        "--timeout", str(timeout),
        "--workspace", workspace,
    ]
    if file_path:
        cmd.extend(["--file", file_path])
    if api_key:
        cmd.extend(["--api-key", api_key])

    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout // 1000 + 60,  # shell timeout slightly > agent timeout
            cwd=str(PROJECT_ROOT),
        )

        # Find JSON output (last line that looks like JSON)
        for line in reversed(result.stdout.strip().split("\n")):
            line = line.strip()
            if line.startswith("{") and line.endswith("}"):
                try:
                    return json.loads(line)
                except json.JSONDecodeError:
                    continue

        return {
            "fullResponse": result.stdout,
            "finalAnswer": "",
            "sessionId": "",
            "durationMs": 0,
            "timedOut": False,
            "error": f"Failed to parse JSON output. stderr: {result.stderr[:500]}",
        }

    except subprocess.TimeoutExpired:
        return {
            "fullResponse": "",
            "finalAnswer": "",
            "sessionId": "",
            "durationMs": timeout,
            "timedOut": True,
            "error": "Process timed out",
        }
    except Exception as e:
        return {
            "fullResponse": "",
            "finalAnswer": "",
            "sessionId": "",
            "durationMs": 0,
            "timedOut": False,
            "error": str(e),
        }


def main():
    parser = argparse.ArgumentParser(description="GAIA Evaluation Harness for OpenClaw")
    parser.add_argument("--data-dir", default="gaia-benchmark/GAIA",
                        help="HuggingFace dataset ID or local path (default: gaia-benchmark/GAIA)")
    parser.add_argument("--level", type=int, choices=[1, 2, 3], default=None,
                        help="Run only this difficulty level (default: all)")
    parser.add_argument("--split", default="validation",
                        help="Dataset split (default: validation)")
    parser.add_argument("--provider", default="anthropic",
                        help="LLM provider (default: anthropic)")
    parser.add_argument("--model", default="claude-opus-4-6",
                        help="Model ID (default: claude-opus-4-6)")
    parser.add_argument("--thinking", default="high",
                        help="Thinking level (default: high)")
    parser.add_argument("--timeout", type=int, default=600000,
                        help="Timeout per question in ms (default: 600000)")
    parser.add_argument("--limit", type=int, default=None,
                        help="Limit number of questions (for testing)")
    parser.add_argument("--resume-from", default=None,
                        help="Resume from this task_id (skip earlier tasks)")
    parser.add_argument("--workspace", default=None,
                        help="Working directory for agent temp files")
    parser.add_argument("--api-key", default=None,
                        help="API key (overrides env/auth-profiles)")
    args = parser.parse_args()

    # Setup
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    level_label = f"level{args.level}" if args.level else "all"
    result_file = RESULTS_DIR / f"gaia_{level_label}_{args.provider}_{args.model}_{timestamp}.jsonl"
    summary_file = RESULTS_DIR / f"gaia_{level_label}_{args.provider}_{args.model}_{timestamp}_summary.json"
    workspace = args.workspace or str(RESULTS_DIR / "workspace")
    os.makedirs(workspace, exist_ok=True)

    print(f"GAIA Evaluation")
    print(f"  Provider: {args.provider}/{args.model}")
    print(f"  Level: {level_label}")
    print(f"  Split: {args.split}")
    print(f"  Thinking: {args.thinking}")
    print(f"  Timeout: {args.timeout}ms")
    print(f"  Results: {result_file}")
    print()

    # Load dataset
    print("Loading GAIA dataset...")
    questions = load_dataset_questions(args.data_dir, args.level, args.split)
    if args.limit:
        questions = questions[:args.limit]
    print(f"Loaded {len(questions)} questions")
    print()

    # Resume logic
    skip = args.resume_from is not None
    completed_ids = set()
    if result_file.exists():
        with open(result_file) as f:
            for line in f:
                entry = json.loads(line)
                completed_ids.add(entry["task_id"])

    # Tracking
    results_by_level: dict[int, list[dict]] = {1: [], 2: [], 3: []}
    total_cost_usd = 0.0

    for i, item in enumerate(questions):
        task_id = item["task_id"]
        level = item["Level"]
        question = item["Question"]
        ground_truth = item.get("Final answer", "")
        file_name = item.get("file_name", "")

        # Skip if resuming
        if skip:
            if task_id == args.resume_from:
                skip = False
            else:
                continue

        # Skip if already completed
        if task_id in completed_ids:
            continue

        # Resolve file path
        file_path = None
        if file_name:
            # Try common locations
            for candidate in [
                os.path.join(args.data_dir, "2023", args.split, file_name),
                os.path.join(args.data_dir, file_name),
                os.path.join("gaia_data", "2023", args.split, file_name),
            ]:
                if os.path.exists(candidate):
                    file_path = os.path.abspath(candidate)
                    break

        print(f"[{i + 1}/{len(questions)}] Level {level} | Task: {task_id[:8]}...")
        print(f"  Q: {question[:100]}{'...' if len(question) > 100 else ''}")
        if file_path:
            print(f"  File: {file_path}")

        # Run agent
        agent_result = run_agent(
            question=question,
            file_path=file_path,
            provider=args.provider,
            model=args.model,
            thinking=args.thinking,
            timeout=args.timeout,
            workspace=workspace,
            api_key=args.api_key,
        )

        model_answer = agent_result.get("finalAnswer", "")
        correct = question_scorer(model_answer, ground_truth) if ground_truth else None
        duration_s = agent_result.get("durationMs", 0) / 1000

        # Build result record
        record = {
            "task_id": task_id,
            "level": level,
            "model_answer": model_answer,
            "ground_truth": ground_truth,
            "correct": correct,
            "duration_s": round(duration_s, 1),
            "timed_out": agent_result.get("timedOut", False),
            "error": agent_result.get("error"),
            "session_id": agent_result.get("sessionId", ""),
        }
        results_by_level[level].append(record)

        # Log result
        status = "✓" if correct else ("✗" if correct is False else "?")
        print(f"  A: {model_answer[:80]}{'...' if len(str(model_answer)) > 80 else ''}")
        print(f"  GT: {ground_truth}")
        print(f"  [{status}] {duration_s:.1f}s")
        if agent_result.get("error"):
            print(f"  Error: {agent_result['error'][:100]}")
        print()

        # Write result immediately (append)
        with open(result_file, "a") as f:
            f.write(json.dumps(record) + "\n")

        # Brief pause between questions
        time.sleep(1)

    # --- Summary ---
    print("=" * 60)
    print("GAIA Evaluation Summary")
    print(f"  Provider: {args.provider}/{args.model}")
    print("=" * 60)

    total_correct = 0
    total_count = 0
    summary = {
        "provider": args.provider,
        "model": args.model,
        "thinking": args.thinking,
        "split": args.split,
        "timestamp": timestamp,
        "levels": {},
    }

    for level in [1, 2, 3]:
        level_results = results_by_level[level]
        if not level_results:
            continue
        correct = sum(1 for r in level_results if r["correct"] is True)
        count = len(level_results)
        pct = (correct / count * 100) if count > 0 else 0
        avg_duration = sum(r["duration_s"] for r in level_results) / count if count else 0
        timed_out = sum(1 for r in level_results if r["timed_out"])
        errors = sum(1 for r in level_results if r["error"])

        total_correct += correct
        total_count += count

        print(f"  Level {level}: {correct}/{count} ({pct:.1f}%) | avg {avg_duration:.1f}s | timeouts: {timed_out} | errors: {errors}")
        summary["levels"][str(level)] = {
            "correct": correct,
            "total": count,
            "accuracy": round(pct, 1),
            "avg_duration_s": round(avg_duration, 1),
            "timed_out": timed_out,
            "errors": errors,
        }

    overall_pct = (total_correct / total_count * 100) if total_count > 0 else 0
    print(f"  Overall: {total_correct}/{total_count} ({overall_pct:.1f}%)")
    summary["overall"] = {
        "correct": total_correct,
        "total": total_count,
        "accuracy": round(overall_pct, 1),
    }

    # Write summary
    with open(summary_file, "w") as f:
        json.dump(summary, f, indent=2)
    print(f"\nResults: {result_file}")
    print(f"Summary: {summary_file}")


if __name__ == "__main__":
    main()

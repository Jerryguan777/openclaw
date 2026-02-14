# GAIA Evaluation for OpenClaw (Layer 0)

Simplified general-purpose agent for running GAIA benchmark evaluations.

## Quick Start

### 1. Prerequisites

```bash
# Python dependencies
pip install datasets huggingface_hub

# HuggingFace token (GAIA is a gated dataset)
export HF_TOKEN=hf_xxxxxxxxxxxxxxxxx

# System tools for file processing
sudo apt-get install -y ffmpeg poppler-utils libreoffice

# Python libraries for file processing
pip install PyMuPDF openpyxl pandas python-pptx Pillow

# Ensure OpenClaw dependencies are installed
cd /path/to/openclaw
pnpm install
```

### 2. Configure API Key

```bash
# At least one LLM provider
export ANTHROPIC_API_KEY=sk-ant-...
# or
export OPENAI_API_KEY=sk-...

# Optional: web search
export BRAVE_API_KEY=...
```

### 3. Run Evaluation

```bash
# Run all levels (validation set)
python gaia-eval/eval.py

# Run specific level
python gaia-eval/eval.py --level 1
python gaia-eval/eval.py --level 2
python gaia-eval/eval.py --level 3

# Use a different model
python gaia-eval/eval.py --provider openai --model gpt-5.2

# Quick test (5 questions)
python gaia-eval/eval.py --level 1 --limit 5

# Resume from a specific task
python gaia-eval/eval.py --resume-from <task_id>
```

### 4. Run a Single Question (Manual Testing)

```bash
npx tsx src/gaia/cli.ts --question "What is the capital of France?"

# With attached file
npx tsx src/gaia/cli.ts --question "Analyze this spreadsheet" --file /path/to/data.xlsx

# JSON output
npx tsx src/gaia/cli.ts --json --question "What is 2+2?"
```

## Architecture

```
gaia-eval/
├── eval.py          # Main evaluation loop (Python)
├── scorer.py        # Official GAIA scoring function
├── README.md        # This file
└── results/         # Evaluation results (auto-created)

src/gaia/
├── index.ts         # Module exports
├── cli.ts           # CLI entry point (called by eval.py)
├── runner.ts        # Simplified agent runner (bypasses Gateway)
├── tools.ts         # 8-tool factory (read/write/edit/exec/web_search/web_fetch/browser/image)
└── system-prompt.ts # GAIA-focused system prompt
```

## Tools Available

| Tool         | Purpose                           |
| ------------ | --------------------------------- |
| `read`       | Read file contents                |
| `write`      | Write files                       |
| `edit`       | Edit files with diffs             |
| `exec`       | Run shell/Python commands         |
| `web_search` | Search the web (Brave/Perplexity) |
| `web_fetch`  | Fetch and parse web pages         |
| `browser`    | Playwright browser automation     |
| `image`      | Analyze images with vision models |

## Output Format

Results are saved in two files:

- `results/gaia_<level>_<provider>_<model>_<timestamp>.jsonl` — per-question results
- `results/gaia_<level>_<provider>_<model>_<timestamp>_summary.json` — aggregate summary

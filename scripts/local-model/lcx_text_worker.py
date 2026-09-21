"""Host-owned offline JSONL worker. Input is data; it never dispatches tools."""
import argparse
import contextlib
import fcntl
import json
import os
import sys
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument("--model", required=True)
args = parser.parse_args()
os.environ["HF_HUB_OFFLINE"] = "1"
model = tokenizer = None


def reply(value):
    sys.stdout.write(json.dumps(value, ensure_ascii=False) + "\n")
    sys.stdout.flush()


reply({"ready": True})
for line in sys.stdin:
    request_id = None
    try:
        if len(line) > 65536:
            raise ValueError("input_limit")
        request = json.loads(line)
        request_id = request["id"]
        prompt = request["prompt"]
        tokens = request["maxTokens"]
        if not isinstance(prompt, str) or len(prompt) > 16000:
            raise ValueError("input_limit")
        if not isinstance(tokens, int) or not 1 <= tokens <= 512:
            raise ValueError("token_limit")
        with open(os.path.join(tempfile.gettempdir(), f"lcx-local-model-{os.getuid()}.lock"), "a") as slot:
            try:
                fcntl.flock(slot, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise ValueError("local_model_busy")
            with contextlib.redirect_stdout(sys.stderr):
                import mlx.core as mx
                from mlx_lm import generate, load
                from mlx_lm.sample_utils import make_sampler
                mx.set_cache_limit(128 * 1024 * 1024)
                mx.set_memory_limit(3 * 1024 * 1024 * 1024)
                if model is None:
                    model, tokenizer = load(args.model)
                rendered = tokenizer.apply_chat_template(
                    [{"role": "user", "content": prompt}],
                    tokenize=False, add_generation_prompt=True, enable_thinking=False,
                )
                output = generate(model, tokenizer, prompt=rendered, max_tokens=tokens,
                                  sampler=make_sampler(temp=0), verbose=False)
                mx.clear_cache()
            reply({"id": request_id, "text": output})
    except Exception as error:
        # No source text, paths or environment values in failure messages.
        code = str(error) if isinstance(error, ValueError) and str(error) in {
            "input_limit", "token_limit", "local_model_busy"
        } else "local_inference_failed"
        reply({"id": request_id, "error": code})

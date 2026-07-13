import argparse
import json
import sys

import json_repair
from huggingface_hub import hf_hub_download
from needle import SimpleAttentionNetwork, generate, get_tokenizer, load_checkpoint


def respond(message):
    sys.stdout.write(json.dumps(message, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", required=True)
    parser.add_argument("--revision", required=True)
    parser.add_argument("--filename", required=True)
    args = parser.parse_args()
    checkpoint = hf_hub_download(repo_id=args.repo, filename=args.filename, revision=args.revision)
    params, config = load_checkpoint(checkpoint)
    model = SimpleAttentionNetwork(config)
    tokenizer = get_tokenizer()
    for line in sys.stdin:
        request = json.loads(line)
        request_id = request.get("id")
        try:
            if request.get("ping"):
                respond({"id": request_id, "calls": []})
                continue
            result = generate(
                model,
                params,
                tokenizer,
                query=request["intent"],
                tools=json.dumps(request["tools"], separators=(",", ":")),
                max_gen_len=request.get("max_tokens", 512),
                stream=False,
            )
            calls = json_repair.loads(result)
            if not isinstance(calls, list) or not calls:
                raise ValueError("model returned no tool calls")
            respond({"id": request_id, "calls": calls})
        except Exception as error:
            respond({"id": request_id, "error": f"{type(error).__name__}: {error}"})


if __name__ == "__main__":
    main()

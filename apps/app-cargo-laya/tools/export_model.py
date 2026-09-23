"""Export Laya's English checkpoint to one ONNX graph (encoder + decision head) with
8-bit weight-only quantization, and check it against PyTorch.

    python3 -m venv .venv && .venv/bin/pip install torch "laya>=0.3.11,<0.4" onnx onnxscript onnxruntime
    .venv/bin/python export_model.py out/model

Writes laya.onnx (+ laya.onnx.data), tokenizer/tokenizer.json and rl_agent_config.json:
everything app/laya_onnx.py needs. Only this script needs PyTorch; the phone doesn't.
"""
import os
import shutil
import sys

import onnx
import torch
from huggingface_hub import snapshot_download
from laya import Agent
from laya.common import QTYPES, build_sequence, collate_items
from laya.onnx_agent import ONNXAgent
from onnxruntime.quantization.matmul_nbits_quantizer import DefaultWeightOnlyQuantConfig, MatMulNBitsQuantizer
from torch.export import Dim

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "app"))
from laya_onnx import Laya  # noqa: E402

out = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else "out/model")
os.makedirs(os.path.join(out, "tokenizer"), exist_ok=True)
src = snapshot_download("convaiinnovations/laya", allow_patterns=[
    "rl_agent_config.json", "model.safetensors", "tokenizer/*", "encoder/*"])

STATE = {"from": "security@paypa1-support.com", "subject": "Your account has been limited",
         "body": "We noticed unusual activity. Verify your identity within 24 hours at "
                 "http://paypa1-support.com/verify or your account will be suspended."}
QUESTIONS = {
    "folder": {"type": "choice", "instructions": "Which folder should this email go to?",
               "criteria": ["inbox", "spam", "phishing"]},
    "urgency": {"type": "score", "instructions": "How much pressure does the sender put on the reader?",
                "criteria": ["none", "low", "medium", "high", "extreme"]},
    "link": {"type": "noul", "instructions": "The email asks the reader to click a link."},
    # One option: the act head's top-2 must still work (laya_onnx pads the option axis).
    "only": {"type": "choice", "instructions": "Which folder?", "criteria": ["spam"]},
}

agent = Agent(src, device="cpu")
items = []
for qd in QUESTIONS.values():
    q = ONNXAgent._to_internal(qd)
    seq, markers = build_sequence(agent.tok, STATE, q, 512, 192)
    items.append({"ids": seq, "markers": markers, "qtype": QTYPES[q["t"]]})
b = collate_items([items], agent.tok.pad_token_id)

# The dynamo exporter keeps batch, sequence and option counts dynamic (the TorchScript
# exporter bakes ModernBERT's attention shapes in).
fp32 = os.path.join(out, "fp32.onnx")
N, L, K = Dim("n", max=64), Dim("L", max=512), Dim("k", max=64)
torch.onnx.export(
    agent.model.eval(), (b["input_ids"], b["attention_mask"], b["marker_pos"], b["marker_mask"], b["qtype"]), fp32,
    dynamo=True, opset_version=18,
    input_names=["input_ids", "attention_mask", "marker_pos", "marker_mask", "qtype"],
    output_names=["logits", "act_logits"],
    dynamic_shapes=({0: N, 1: L}, {0: N, 1: L}, {0: N, 1: K}, {0: N, 1: K}, {0: N}),
)

# Stale shape annotations near the act head break the quantizer's shape inference.
m = onnx.load(fp32)
del m.graph.value_info[:]
# 8-bit weights, int8 compute (accuracy_level 4): 2x less memory than fp32 and ~1.7x faster on
# phone CPUs. 4-bit and int8 dynamic quantization drift too far (probabilities off by 0.1-0.2).
q = MatMulNBitsQuantizer(m, algo_config=DefaultWeightOnlyQuantConfig(block_size=32, is_symmetric=True, accuracy_level=4, bits=8))
q.process()
onnx.save(q.model.model, os.path.join(out, "laya.onnx"), save_as_external_data=True, location="laya.onnx.data", size_threshold=1024)
for f in os.listdir(out):
    if f.startswith("fp32.onnx"):
        os.remove(os.path.join(out, f))

shutil.copy(os.path.join(src, "rl_agent_config.json"), out)
shutil.copy(os.path.join(src, "tokenizer", "tokenizer.json"), os.path.join(out, "tokenizer"))

# The ONNX runner (tokenizers, numpy) must match laya on PyTorch.
ref = agent.system_one(STATE, QUESTIONS)
got = Laya(out).predict(STATE, QUESTIONS)
assert ref["usage"] == got["usage"], (ref["usage"], got["usage"])
for qid, a in ref["answers"].items():
    pa = dict(a.get("probabilities") or {"p": a["noul"]}, act=a["action"]["act_probability"])
    b = got["answers"][qid]
    pb = dict(b.get("probabilities") or {"p": b["noul"]}, act=b["action"]["act_probability"])
    diff = max(abs(pa[k] - pb[k]) for k in pa)
    print("%-8s max probability difference %.4f" % (qid, diff))
    assert diff < 0.05, qid
print("ok:", out)

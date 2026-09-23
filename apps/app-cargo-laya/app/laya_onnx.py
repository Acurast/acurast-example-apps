"""Laya inference on ONNX Runtime, without PyTorch or transformers.

Prompt building, option rendering, temperatures and the answer format are ported
from the `laya` package 0.3.11 (laya/common.py, laya/onnx_agent.py, Apache-2.0,
https://huggingface.co/convaiinnovations/laya), so answers match `laya.Agent`.
The model is Laya's English checkpoint exported to ONNX (encoder + decision head
in one graph) with 8-bit weight-only quantization (MatMulNBits); see README.md.
"""
import json
import math
import os
import threading
from typing import Any, Dict, List, Union

import numpy as np
import onnxruntime as ort
from tokenizers import Tokenizer

QTYPES = {"choice": 0, "score": 1, "noul": 2}
QTYPE_NAMES = {v: k for k, v in QTYPES.items()}
TEMP_MIN, TEMP_MAX = 0.5, 5.0


def serialize_state(state: Union[str, dict, list]) -> str:
    return state if isinstance(state, str) else json.dumps(state, ensure_ascii=False)


def render_criterion(value) -> str:
    if isinstance(value, str):
        return value
    return json.dumps(value, ensure_ascii=False, separators=(", ", ": "), default=str)


def _noul_labels(labels=None):
    labels = {"false": "false", "true": "true"} if labels is None else labels
    bad = ValueError("noul labels must map exactly 'false' and 'true' to distinct non-empty strings")
    if not isinstance(labels, dict) or set(labels) != {"false", "true"}:
        raise bad
    f, t = labels["false"], labels["true"]
    if not isinstance(f, str) or not isinstance(t, str) or not f.strip() or not t.strip() or f.strip() == t.strip():
        raise bad
    return f.strip(), t.strip()


def render_options(q: Dict) -> List[str]:
    t, crit = q["t"], q.get("crit")
    if t != "noul" and "labels" in q:
        raise ValueError("labels is only supported for noul questions")
    if t == "choice":
        return [k if v is None or v == "" else "%s: %s" % (k, render_criterion(v)) for k, v in crit.items()]
    if t == "score":
        return ["level %d: %s" % (i, render_criterion(c)) for i, c in enumerate(crit)]
    crit = crit or {}
    false_label, true_label = _noul_labels(q.get("labels"))
    false_crit, true_crit = crit.get("false"), crit.get("true")
    return [
        false_label + ": " + (render_criterion(false_crit) if false_crit not in (None, "") else "no, the statement does not hold"),
        true_label + ": " + (render_criterion(true_crit) if true_crit not in (None, "") else "yes, the statement holds"),
    ]


def check_question(qid: str, qdef: Any) -> None:
    if not isinstance(qdef, dict):
        raise ValueError("question %r: definition must be a dict, got %s" % (qid, type(qdef).__name__))
    t = qdef.get("type")
    if t not in QTYPES:
        raise ValueError("question %r: unknown type %r; use one of %s" % (qid, t, sorted(QTYPES)))
    if "instructions" not in qdef:
        raise ValueError("question %r: no 'instructions'; add the text the model should answer" % (qid,))
    crit = qdef.get("criteria")
    if t == "choice" and (not isinstance(crit, (dict, list)) or not crit):
        raise ValueError("question %r: a choice question takes 'criteria' as a non-empty dict of "
                         "label -> description, or a list of labels" % (qid,))
    if t == "score" and (not isinstance(crit, list) or not crit):
        raise ValueError("question %r: a score question takes 'criteria' as a non-empty list of level "
                         "descriptions, index 0 first" % (qid,))
    if t == "noul" and crit is not None:
        if not isinstance(crit, dict) or not {str(k).lower() for k in crit} <= {"true", "false"}:
            raise ValueError("question %r: a noul question takes 'criteria' keyed only 'true'/'false', "
                             "or omits it" % (qid,))


def to_internal(qdef: Dict) -> Dict:
    t, crit = qdef["type"], qdef.get("criteria")
    if t == "choice" and isinstance(crit, list):
        crit = {c: None for c in crit}
    elif t == "noul" and isinstance(crit, dict):
        crit = {str(k).lower(): v for k, v in crit.items()}
    ins = qdef["instructions"]
    q = {"t": t, "ins": ins if isinstance(ins, str) else json.dumps(ins, ensure_ascii=False), "crit": crit}
    if "labels" in qdef:
        q["labels"] = qdef["labels"]
    return q


def clamp_temperature(t) -> float:
    try:
        t = float(t)
    except (TypeError, ValueError):
        return 1.0
    return 1.0 if not math.isfinite(t) else min(TEMP_MAX, max(TEMP_MIN, t))


def temp_bucket(qtype: int, k: int) -> str:
    size = "2" if k <= 2 else "3-5" if k <= 5 else "6-10" if k <= 10 else "11+"
    return "%s:%s" % (QTYPE_NAMES[qtype], size)


def confidence(p: np.ndarray, k: int) -> float:
    if k < 2:
        return 1.0
    ent = -(p[:k] * np.log(np.clip(p[:k], 1e-12, 1.0))).sum()
    return float(np.clip(1.0 - ent / math.log(k), 0.0, 1.0))


def perf_cores() -> List[int]:
    """The cores to run on: every core this process may use, minus the efficiency cluster.

    Core speed comes from the kernel's cpu_capacity (the scheduler's rating, largest core
    1024), else the max frequency. Once a little core joins, the fast cores wait for it
    (Pixel 7a: 2 X1 + 2 A78 0.37 s per question, 2 X1 alone 0.81 s, adding little cores
    2.6 s). A Cargo job may get fewer than all cores, so only allowed ones count.
    """
    allowed = sorted(os.sched_getaffinity(0))
    for f in ("cpu_capacity", "cpufreq/cpuinfo_max_freq"):  # one source for all cores
        try:
            speed = {c: int(open("/sys/devices/system/cpu/cpu%d/%s" % (c, f)).read()) for c in allowed}
            break
        except (OSError, ValueError):
            pass
    else:
        return allowed
    slowest = min(speed.values())
    fast = [c for c in allowed if speed[c] > slowest]
    return fast or allowed


class Laya:
    """One ONNX session plus the tokenizer; `predict` returns laya's /v1/systemone payload."""

    def __init__(self, model_dir: str, threads: int = 0):
        """threads=0: one thread per performance core."""
        self.model_dir = model_dir
        with open(os.path.join(model_dir, "rl_agent_config.json")) as f:
            self.cfg = json.load(f)
        self.tok = Tokenizer.from_file(os.path.join(model_dir, "tokenizer", "tokenizer.json"))
        tid = self.tok.token_to_id
        self.cls, self.sep, self.mask, self.pad = tid("[CLS]"), tid("[SEP]"), tid("[MASK]"), tid("[PAD]")
        self.temperature = [clamp_temperature(t) for t in self.cfg.get("temperature", [1.0, 1.0, 1.0])]
        self.temperature_by_options = {k: clamp_temperature(v) for k, v in self.cfg.get("temperature_by_options", {}).items()}
        self.lock = threading.Lock()
        self.loaded = ["english"]
        # Pin before the session exists: ONNX Runtime's worker threads inherit it, and so
        # do the server's request threads started from this one.
        self.cores = perf_cores()
        os.sched_setaffinity(0, self.cores)
        self.session = self._session(threads or len(self.cores))

    def _session(self, threads: int):
        so = ort.SessionOptions()
        so.intra_op_num_threads = threads
        so.inter_op_num_threads = 1
        return ort.InferenceSession(os.path.join(self.model_dir, "laya.onnx"), so, providers=["CPUExecutionProvider"])

    def _ids(self, text: str) -> List[int]:
        return self.tok.encode(text, add_special_tokens=False).ids

    def _sequence(self, state, q, max_len: int, head_max_len: int):
        """[CLS] <type> instructions [SEP] [MASK] opt0 [MASK] opt1 ... [SEP] state [SEP]."""
        opts = render_options(q)
        head = self._ids("%s question: %s" % (q["t"], str(q["ins"]).replace("[MASK]", " ")))
        opt_ids = [[self.mask] + self._ids(" " + o.replace("[MASK]", " "))[:48] for o in opts]
        budget = head_max_len - sum(len(o) for o in opt_ids)
        if budget < 16:
            per = max(4, (head_max_len - 16) // max(1, len(opt_ids)))
            opt_ids = [o[:per] for o in opt_ids]
            budget = head_max_len - sum(len(o) for o in opt_ids)
        ids = [self.cls] + head[:max(8, budget)] + [self.sep]
        markers = []
        for o in opt_ids:
            markers.append(len(ids))
            ids.extend(o)
        ids.append(self.sep)
        room = max(0, max_len - len(ids) - 1)
        ids = ids + self._ids(serialize_state(state).replace("[MASK]", " "))[:room] + [self.sep]
        return ids[:max_len], [m for m in markers if m < max_len]

    def predict(self, state, questions: Dict[str, Dict], model=None) -> Dict[str, Any]:
        ids = list(questions)
        for qid in ids:
            check_question(qid, questions[qid])
        qs = [to_internal(questions[qid]) for qid in ids]
        items = []
        for qid, q in zip(ids, qs):
            seq, markers = self._sequence(state, q, self.cfg.get("max_len", 512), self.cfg.get("head_max_len", 192))
            if len(markers) != len(render_options(q)):
                raise ValueError("question %r options exceed head_max_len" % (qid,))
            items.append((seq, markers, QTYPES[q["t"]]))

        # K >= 2: the exported act head takes the top-2 option probabilities (laya pads a lone
        # option with 0; a masked second slot gives the same). Else 1-option questions fail.
        n, L, K = len(items), max(len(s) for s, _, _ in items), max(2, max(len(m) for _, m, _ in items))
        inp = {"input_ids": np.full((n, L), self.pad, np.int64), "attention_mask": np.zeros((n, L), np.int64),
               "marker_pos": np.zeros((n, K), np.int64), "marker_mask": np.zeros((n, K), bool),
               "qtype": np.array([t for _, _, t in items], np.int64)}
        for i, (seq, markers, _) in enumerate(items):
            inp["input_ids"][i, :len(seq)] = seq
            inp["attention_mask"][i, :len(seq)] = 1
            inp["marker_pos"][i, :len(markers)] = markers
            inp["marker_mask"][i, :len(markers)] = True
        with self.lock:
            logits, act_logits = self.session.run(["logits", "act_logits"], inp)
        act = np.exp(act_logits - act_logits.max(-1, keepdims=True))
        act /= act.sum(-1, keepdims=True)

        answers = {}
        for r, (qid, q) in enumerate(zip(ids, qs)):
            k, qt = len(items[r][1]), QTYPES[q["t"]]
            z = logits[r, :k] / self.temperature_by_options.get(temp_bucket(qt, k), self.temperature[qt])
            p = np.exp(z - z.max())
            p /= p.sum()
            ext = {"act_probability": round(float(act[r, 0]), 4)}
            if q["t"] == "choice":
                keys = list(q["crit"])
                answers[qid] = {"type": "choice", "choice": keys[int(p.argmax())],
                                "probabilities": {kk: round(float(v), 4) for kk, v in zip(keys, p)},
                                "confidence": round(confidence(p, k), 4), "action": ext}
            elif q["t"] == "score":
                answers[qid] = {"type": "score", "score": round(float((np.arange(k) * p).sum()), 4),
                                "legend": {str(i): c for i, c in enumerate(q["crit"])},
                                "probabilities": {str(i): round(float(v), 4) for i, v in enumerate(p)},
                                "confidence": round(confidence(p, k), 4), "action": ext}
            else:
                answers[qid] = {"type": "noul", "noul": round(float(p[1]), 4),
                                "confidence": round(max(float(p[1]), 1.0 - float(p[1])), 4), "action": ext}
        return {"model": "laya-english-onnx-int8", "answers": answers,
                "usage": {"input_tokens": int(inp["attention_mask"].sum()), "output_tokens": 0}}

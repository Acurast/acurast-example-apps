"""python3 tools/test_server.py — checks server.py's thread choice, stream framing and request parsing."""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "app"))
import server  # noqa: E402  (importing starts nothing: MNN, the pipe and the HTTP server start in main())

# Pixel 7a (Tensor G2), cpu_capacity read on the phone: 4x A55 158, 2x A78 763, 2x X1 1024 -> 4 fast cores.
assert server.pick_threads(dict(enumerate([158] * 4 + [763] * 2 + [1024] * 2))) == ([4, 5, 6, 7], 4)
# Snapdragon 8 Elite-class: 6 performance + 2 prime cores, no efficiency cluster -> all 8.
assert server.pick_threads(dict(enumerate([870] * 6 + [1024] * 2))) == (list(range(8)), 8)
# Three clusters with 6 fast cores (e.g. 8 Gen 3: 2x A520 + 5x A720 + X4) -> still 4.
assert server.pick_threads(dict(enumerate([280] * 2 + [800] * 5 + [1024])))[1] == 4
# No cpu_capacity, max frequency (ratio 0.75). Snapdragon 855: A55 1.79, A76 2.42, A76 2.84 GHz -> 4 fast cores.
assert server.pick_threads(dict(enumerate([1785000] * 4 + [2419000] * 3 + [2841000])), 0.75) == ([4, 5, 6, 7], 4)
# Snapdragon 8 Gen 2 by frequency: A510 2.02 GHz is 63 % of the X3, still an efficiency core -> 4.
assert server.pick_threads(dict(enumerate([2016000] * 3 + [2803000] * 4 + [3187000])), 0.75) == ([3, 4, 5, 6, 7], 4)
# Snapdragon 8 Elite by frequency: 6x 3.53 + 2x 4.32 GHz -> all 8.
assert server.pick_threads(dict(enumerate([3532800] * 6 + [4320000] * 2)), 0.75)[1] == 8
# sysfs unreadable -> 4 threads, no pinning.
assert server.pick_threads({}) == ([], 4)

# Hold back bytes that may be MNN's closing "\n" or the start of its trailer, nothing else.
assert server._held(b"Four\n", b"\n" + server.TAIL) == 1
assert server._held(b"Four\n[MNNLLM] resp", b"\n" + server.TAIL) == len("\n[MNNLLM] resp")
assert server._held(b"Four [MNN", server.TAIL) == len("[MNN")
assert server._held("你好".encode(), b"\n" + server.TAIL) == 0

msgs, max_tokens, thinking, stream = server.parse_request({
    "messages": [{"role": "developer", "content": "Be brief."},
                 {"role": "user", "content": [{"type": "text", "text": "Hi\0\ud800"}]}],
    "max_tokens": 10**6, "stream": True, "chat_template_kwargs": {"enable_thinking": True}})
assert server.parse_request({"messages": [{"role": "user", "content": "x"}], "stream": "false",
                             "chat_template_kwargs": {"enable_thinking": "false"}})[2:] == (False, False)
assert msgs == [{"role": "system", "content": "Be brief."}, {"role": "user", "content": "Hi?"}]
assert (max_tokens, thinking, stream) == (server.MAX_TOKENS, True, True)
for bad in ({}, {"messages": ["hi"]}, {"messages": [{"role": ["user"], "content": "x"}]}, {"messages": [{"role": "tool", "content": "x"}]}):
    try:
        server.parse_request(bad)
        raise AssertionError(f"accepted {bad}")
    except server.HTTPError as e:
        assert e.status == 400
print("ok")

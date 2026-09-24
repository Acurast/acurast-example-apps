# Acurast ONNX base image (Cargo)

A small rootfs for Cargo (Shell runtime) jobs that run ONNX models on the phone's CPU: Alpine 3.24, Python 3.14, ONNX Runtime 1.24, numpy, tokenizers, plus openssl, Dropbear and curl for the Acurast tunnel, SSH and callbacks. 47 MB download, 218 MB unpacked, no compiler, no PyTorch.

There is no model inside: apps download their weights at start (see [app-cargo-laya](../../apps/app-cargo-laya)), so one image serves every ONNX app and the processor caches it by sha256.

```json
"image": {
  "url": "https://cdn.papers.tech/files/cargo-laya/b302053beeab0b969302656f0ee2c54158367b1074306ab3b00a8b101c8476b0/onnx-base/acurast-onnx-alpine3.24.2-aarch64.tar.xz",
  "sha256": "b302053beeab0b969302656f0ee2c54158367b1074306ab3b00a8b101c8476b0"
}
```

`./build.sh` rebuilds it with Docker and prints the sha256. Packages come from Alpine's repositories; `tokenizers` comes from PyPI (musl wheel).

Licences: `./sources.sh` writes `out/THIRD-PARTY.tsv` (every package, version and licence) and `out/sources/` (Alpine's recipe and the upstream source for every GPL, LGPL or MPL package). They are published next to the image (`files/cargo-laya/.../onnx-base/THIRD-PARTY.tsv`, `SOURCE.md`, `sources/`): publish them again whenever the image changes.

Notes for apps:

- Alpine uses musl, not glibc: pip packages need musllinux wheels (or an Alpine `py3-*` package).
- The processor accepts only `.tar.xz` images and strips the first entry's top-level directory, so the archive holds a single top-level folder.

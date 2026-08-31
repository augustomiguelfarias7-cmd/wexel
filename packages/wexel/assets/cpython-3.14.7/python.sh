#!/bin/sh
exec /home/ubuntu/wexel/toolchains/wasmtime/wasmtime run --wasm max-wasm-stack=16777216 --argv0 cross-build/wasm32-wasip1/python.wasm --dir /home/ubuntu/wexel/vendor/cpython::/ --env PYTHONPATH=/cross-build/wasm32-wasip1/build/lib.wasi-wasm32-3.14 /home/ubuntu/wexel/vendor/cpython/cross-build/wasm32-wasip1/python.wasm "$@"

#!/bin/bash
# Build the interpreter speed spike for native and WASM. Usage: build.sh native|wasm [extra flags]
cd "$(dirname "$0")"; E=../../eka2l1/src/emu
SRCS="$E/common/src/bytes.cpp $E/cpu/src/dyncom/*.cpp $E/cpu/src/dyncom/vfp/*.cpp"
INC="-Ishim -I$E/cpu/include -I$E/common/include"
mkdir -p out
case "$1" in
  native) shift; g++ -std=c++20 -O3 -DNDEBUG -w $INC bench.cpp $SRCS -o out/bench_native "$@";;
  wasm) shift; . ../../.toolchain/env.sh; em++ -std=c++20 -O3 -DNDEBUG -w $INC bench.cpp $SRCS -o out/bench_wasm.js -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=64MB -sENVIRONMENT=node "$@";;
esac

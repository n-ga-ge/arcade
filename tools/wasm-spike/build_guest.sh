#!/bin/bash
# Cross-compile the ARMv4T guest workload (ARM and Thumb variants) into C headers.
cd "$(dirname "$0")"; A=../../.toolchain/armcc/bin
for mode in arm thumb; do
  $A/clang --target=armv4t-none-eabi -m$mode -O2 -ffreestanding -fno-builtin -nostdlib -c guest.c -o out/guest_$mode.o &&
  $A/clang --target=armv4t-none-eabi -c start.S -o out/start.o &&
  $A/ld.lld -T link.ld out/start.o out/guest_$mode.o -o out/guest_$mode.elf &&
  $A/llvm-objcopy -O binary --only-section=.text --only-section=.data out/guest_$mode.elf guest_$mode.bin &&
  { xxd -i guest_$mode.bin; echo "static const unsigned int guest_${mode}_entry = 0x$($A/llvm-nm out/guest_$mode.elf | awk '$3=="_start"{print $1}');"; } > guest_$mode.h
  rm -f guest_$mode.bin
done

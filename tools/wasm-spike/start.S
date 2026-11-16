    .section .text.start, "ax"
    .global _start
    .arm
_start:
    ldr r0, =bench_main
    bx r0
